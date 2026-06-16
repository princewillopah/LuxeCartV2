export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    status: "ok",
    service: "luxecart-frontend",
    time: new Date().toISOString(),
  });
}
