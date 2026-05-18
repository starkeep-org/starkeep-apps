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
    const { join, resolve } = await import("node:path");
    const { homedir } = await import("node:os");

    const starkeepDataDir = process.env.STARKEEP_DATA_DIR ?? join(homedir(), ".starkeep");
    const configPath = join(starkeepDataDir, "config.json");
    if (!existsSync(configPath)) {
      throw new Error(`~/.starkeep/config.json not found at ${configPath}. Complete cloud setup in admin-web first.`);
    }
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
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
    };

    const outputsPath = resolve(infraRoot, "photos-cloud-config.json");
    $resolve(outputs).apply((resolved) => {
      writeFileSync(outputsPath, JSON.stringify(resolved, null, 2));
    });

    return outputs;
  },
});
