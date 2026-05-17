import { NextResponse } from "next/server";

export const runtime = "nodejs";

// TODO: Implement share link generation once the platform exposes an access-control
// endpoint for creating time-limited tokens. For now, return 501 so the UI can
// degrade gracefully.
export async function POST(): Promise<Response> {
  return NextResponse.json(
    { error: "Share links are not yet supported in this version" },
    { status: 501 },
  );
}
