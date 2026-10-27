import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { getRequestDetails } from "@/lib/usageDb";
import { redactRequestDetails } from "@/lib/requestDetailsPayload";

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    
    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    
    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }
    
    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }
    
    const filter = {
      page,
      pageSize
    };
    
    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    
    const result = await getRequestDetails(filter);
    const settings = await getSettings();

    // Redact conversation payloads by default: the stored details include full
    // request bodies (user prompts, tool calls) and provider responses. Returning
    // them wholesale lets any dashboard-authenticated user (or, if requireLogin
    // is disabled, anyone) read every user's conversation history. The opt-in
    // setting is intended for trusted/local dashboards that need raw debugging
    // data. Metadata (model, tokens, latency, status) is always returned.
    const details = settings.observabilityShowPayloads === true
      ? result.details
      : redactRequestDetails(result.details);

    return NextResponse.json({ ...result, details });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
