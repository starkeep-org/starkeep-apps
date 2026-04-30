/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "starkeep-photos",
      removal: input?.stage === "prod" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    // process.cwd() is the infra directory when SST runs sst deploy.
    // Admin-web writes starkeep-config.json one level up (photos repo root) before deploying.
    const configPath = resolve(process.cwd(), "../starkeep-config.json");
    if (!existsSync(configPath)) {
      throw new Error(`starkeep-config.json not found at ${configPath}. Deploy photos-web from admin-web to provision this file.`);
    }
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      region: string;
      userPoolId: string;
      userPoolClientId: string;
      auroraEndpoint: string;
      s3Bucket: string;
      apiGatewayUrl: string;
    };

    const stage = $app.stage;
    const region = aws.getRegionOutput().name;
    const { userPoolId, userPoolClientId } = config;

    const photosFunction = new sst.aws.Function(`starkeep-photos-api-${stage}`, {
      handler: "src/photos-handler.handler",
      runtime: "nodejs22.x",
      timeout: "30 seconds",
      memory: "512 MB",
      nodejs: {
        install: ["pg", "sharp", "@aws-sdk/dsql-signer", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "@aws-sdk/lib-storage"],
      },
      environment: {
        AURORA_ENDPOINT: config.auroraEndpoint,
        S3_BUCKET: config.s3Bucket,
      },
      permissions: [
        {
          actions: ["dsql:DbConnectAdmin"],
          resources: [$interpolate`arn:aws:dsql:${region}:*:cluster/*`],
        },
        {
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
          resources: [
            `arn:aws:s3:::${config.s3Bucket}`,
            `arn:aws:s3:::${config.s3Bucket}/*`,
          ],
        },
      ],
    });

    const gateway = new sst.aws.ApiGatewayV2(`starkeep-photos-gateway-${stage}`, {
      cors: {
        allowOrigins: ["*"],
        allowMethods: ["POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });

    const authorizer = gateway.addAuthorizer({
      name: "cognitoJwt",
      jwt: {
        audiences: [userPoolClientId],
        issuer: $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
      },
    });

    gateway.route("OPTIONS /{proxy+}", photosFunction.arn);
    gateway.route("POST /data/generate", photosFunction.arn, {
      auth: { jwt: { authorizer: authorizer.id } },
    });

    // __dirname is infra/.sst/platform/ (where SST compiles the config).
    // Go up two levels to reach the infra root.
    const infraRoot = resolve(__dirname, "..", "..");
    const webAssetsFile = resolve(infraRoot, "src/web-assets.json");
    const photosWebFn = existsSync(webAssetsFile)
      ? new sst.aws.Function(`starkeep-photos-web-${stage}`, {
          handler: "src/static-server.handler",
          runtime: "nodejs22.x",
          memory: "256 MB",
          url: true,
        })
      : undefined;

    const outputs = {
      photosApiGatewayUrl: gateway.url,
      ...(photosWebFn ? { photosWebUrl: photosWebFn.url } : {}),
      region: "us-east-1",
    };

    const outputsPath = resolve(infraRoot, "photos-cloud-config.json");
    $resolve(outputs).apply((resolved) => {
      writeFileSync(outputsPath, JSON.stringify(resolved, null, 2));
    });

    return outputs;
  },
});
