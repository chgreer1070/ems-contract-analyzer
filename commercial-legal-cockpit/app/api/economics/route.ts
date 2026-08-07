import { calculateEconomics, type EconomicsInput } from "@/lib/economics";

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as EconomicsInput;
    return Response.json({ ok: true, result: calculateEconomics(input) });
  } catch {
    return Response.json({ ok: false, error: "Invalid economics input." }, { status: 400 });
  }
}
