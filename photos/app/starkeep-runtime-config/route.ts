export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    apiGatewayUrl: process.env.STARKEEP_API_GATEWAY_URL ?? "",
    photosApiGatewayUrl: process.env.STARKEEP_API_GATEWAY_URL ?? "",
    region: process.env.AWS_REGION ?? "",
    userPoolId: process.env.STARKEEP_USER_POOL_ID ?? "",
    userPoolClientId: process.env.STARKEEP_USER_POOL_CLIENT_ID ?? "",
    identityPoolId: process.env.STARKEEP_IDENTITY_POOL_ID ?? "",
    s3Bucket: process.env.STARKEEP_FILES_BUCKET ?? "",
    s3Region: process.env.AWS_REGION ?? "",
  });
}
