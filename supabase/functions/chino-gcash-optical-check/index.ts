import { opticalCheckHandler } from "./handler.ts";
Deno.serve(opticalCheckHandler({
  serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  serviceKeyHash: Deno.env.get("OCR_DIAGNOSTIC_SERVICE_KEY_SHA256") || "",
  visionKey: Deno.env.get("GOOGLE_VISION_API_KEY") || "",
}));
