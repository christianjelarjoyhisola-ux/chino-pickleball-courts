import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { emailCorsHeaders, isAllowedEmailOrigin } from "../_shared/email-request.ts";
import { sendMailerooEmail, isEmailAddress } from "../_shared/maileroo.ts";
import { escapeHtml } from "../_shared/paddle-rage-email.ts";

const hour = (value: string | number) => {
  const h = Number(value) % 24;
  return `${h % 12 || 12}:00 ${h < 12 ? "AM" : "PM"}`;
};
const schedule = (date: string, slots: string[]) => {
  const hours = slots.map(Number).sort((a, b) => a - b);
  return `${date} · ${hour(hours[0])}–${hour(hours[hours.length - 1] + 1)} (Philippine time)`;
};

Deno.serve(async (req) => {
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...emailCorsHeaders(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: emailCorsHeaders(req) });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);
  if (!isAllowedEmailOrigin(req)) return respond({ error: "Origin not allowed" }, 403);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  try {
    let authorized = false;
    const cronSecret = req.headers.get("x-cron-secret");
    if (cronSecret) {
      const { data, error } = await db.rpc("verify_balance_cron_secret", { p_token: cronSecret });
      authorized = !error && data === true;
    } else {
      const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data, error } = await db.auth.getUser(bearer);
      if (!error && data.user) {
        const account = await db.from("accounts").select("role,status").eq("id", data.user.id).single();
        authorized = !account.error && account.data.status === "active" && ["owner", "court_owner"].includes(account.data.role);
      }
    }
    if (!authorized) return respond({ error: "Owner authorization required" }, 403);
    const { data: jobs, error } = await db.rpc("claim_weather_emails");
    if (error) throw new Error("Could not claim weather notifications");
    let sent = 0;
    let failed = 0;
    for (const job of jobs || []) {
      let failure = "";
      try {
        const { data: replacement, error: replacementError } = await db.from("weather_replacements").select("*").eq("id", job.replacement_id).single();
        if (replacementError || !replacement) throw new Error("Replacement details unavailable");
        if (!isEmailAddress(replacement.customer_email || "")) throw new Error("No valid player email. Use Copy player link to help this player.");
        const { data: items, error: itemError } = await db.from("weather_replacement_items").select("*").eq("replacement_id", replacement.id);
        if (itemError || !items?.length) throw new Error("Booking details unavailable");
        const confirmation = job.kind === "confirmation";
        const selected = confirmation ? items.filter((item) => item.id === job.item_id) : items;
        const site = (Deno.env.get("APP_PUBLIC_URL") || "https://chinopickleballcourt.com").replace(/\/$/, "");
        const link = `${site}/weather-reschedule#${replacement.access_token}`;
        const title = confirmation ? "Your new court time is confirmed" : "A rain check for your next game";
        const intro = confirmation
          ? "Your weather replacement has been saved. Your original payment and booking fee stay with your reservation."
          : "Your court booking has been affected by a weather closure. Choose a new available date and time using your private link below. Your full booked duration is protected.";
        const details = selected.map((item) => `${item.court_name || "Court"} · ${item.booking_ref}\n${confirmation ? schedule(item.new_date, item.new_slots) : schedule(item.old_date, item.old_slots)}${confirmation ? `\nPreviously: ${schedule(item.old_date, item.old_slots)}` : ""}`).join("\n\n");
        const policy = "No extra court charge, booking fee or rescheduling fee for your replacement on the same court and for the same duration. Any original unpaid balance remains unchanged. Times are confirmed only when you save your selection.";
        const subject = confirmation ? `New schedule confirmed · ${replacement.family_key} | CHINO` : `Weather closure: choose your new time · ${replacement.family_key} | CHINO`;
        await sendMailerooEmail({
          to: replacement.customer_email, toName: replacement.customer_name, subject,
          plain: `Hi ${replacement.customer_name},\n\n${intro}\n\n${details}\n\n${policy}\n\n${confirmation ? "View your replacement" : "Choose a new date and time"}: ${link}\n\nCHINO Pickleball Courts`,
          html: `<div style="background:#edf2f7;padding:28px 12px;font-family:Arial,sans-serif;color:#172b42"><div style="max-width:580px;margin:auto;background:#fff;border-radius:20px;overflow:hidden"><div style="padding:30px;background:#142c47;color:white"><p style="letter-spacing:3px;font-size:12px;color:#a8c9e8">CHINO · PICKLEBALL COURTS</p><h1 style="font-size:27px;line-height:1.25">${escapeHtml(title)}</h1></div><div style="padding:30px"><p>Hi ${escapeHtml(replacement.customer_name)},</p><p style="line-height:1.7">${escapeHtml(intro)}</p><div style="padding:20px;background:#f0f5fa;border-radius:12px;line-height:1.8;white-space:pre-line">${escapeHtml(details)}</div><p style="font-size:14px;line-height:1.7">${escapeHtml(policy)}</p><p style="margin:28px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:16px 24px;background:#30699e;color:#fff;text-decoration:none;border-radius:10px;font-weight:bold">${confirmation ? "View your replacement" : "Choose a new date & time"}</a></p><p style="font-size:12px;color:#617489">This private link belongs to your booking. Need help? Reply to this email.</p></div></div></div>`,
          tags: { message_type: `weather-${job.kind}` },
        });
        sent++;
      } catch (error) {
        failure = error instanceof Error ? error.message.slice(0, 250) : "Email delivery failed";
        failed++;
      }
      const { error: finishError } = await db.from("weather_email_outbox").update({
        status: failure ? "failed" : "sent", sent_at: failure ? null : new Date().toISOString(),
        last_error: failure || null, lease_until: null, lease_token: null,
        available_at: new Date(Date.now() + Math.min(60, 2 ** job.attempts) * 60000).toISOString(),
      }).eq("id", job.id).eq("lease_token", job.lease_token).eq("status", "sending");
      if (finishError) throw new Error("Notification delivery status could not be saved");
    }
    return respond({ sent, failed });
  } catch {
    return respond({ error: "Weather notifications could not finish. Queued emails will retry automatically." }, 500);
  }
});
