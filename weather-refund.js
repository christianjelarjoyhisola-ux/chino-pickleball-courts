(function(root){
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const when = value => value ? new Date(value).toLocaleString('en-PH',{timeZone:'Asia/Manila'})+' PH' : '—';
  const schedule = (date,slots) => `${date || '—'} · ${(slots||[]).map(h=>`${h}:00`).join(', ')}`;
  function markup(rows,owner){
    if(!rows.length) return '';
    return `<h3>Weather reschedule used</h3>${rows.map(r=>`<div class="booking-detail-section wx-row"><div><strong>${escape(r.court || r.ref)}</strong><p>${escape(r.ref)}</p><p>Original: ${escape(schedule(r.oldDate,r.oldSlots))}<br>Replacement: ${escape(schedule(r.newDate,r.newSlots))}</p><p>Used: ${escape(when(r.usedAt))}</p><strong>${r.overrideAt?'System-owner refund exception authorized':'Refund blocked — weather reschedule used'}</strong>${r.overrideAt?`<p>${escape(r.overrideReason)}</p><p>${escape(r.overrideBy || 'System owner')} · ${escape(when(r.overrideAt))}</p>`:owner?`<p><button type="button" class="btn btn-g" data-weather-refund="${escape(r.id)}">Authorize refund exception</button></p>`:'<p>Only the system owner can override with a recorded reason.</p>'}</div></div>`).join('')}<p>An exception does not send money or mark a refund as paid.</p>`;
  }
  const peso = value => '₱'+Number(value).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
  // Who cancelled an unused credit for a manual refund, when, and why.
  function revokedDetails(r){
    const refund=[r.refundAmount!=null?peso(r.refundAmount):'',r.refundReference?`Ref ${r.refundReference}`:''].filter(Boolean).join(' · ');
    return `<p>${escape(r.revokeReason)}</p>${refund?`<p>Refund: ${escape(refund)}</p>`:''}<p>${escape(r.revokedBy || 'Owner')} · ${escape(when(r.revokedAt))}</p>`;
  }
  function openMarkup(rows,canRevoke){
    if(!rows.length) return '';
    return `<h3>Weather credit</h3>${rows.map(r=>`<div class="booking-detail-section wx-row"><div><strong>${escape(r.court || r.ref)}</strong><p>${escape(r.ref)}</p><p>Original: ${escape(schedule(r.oldDate,r.oldSlots))}</p>${r.status==='revoked'?`<strong>Weather credit cancelled — player chose a refund</strong>${revokedDetails(r)}`:`<strong>Weather credit available — not yet used</strong>${canRevoke?`<p><button type="button" class="btn btn-g" data-weather-revoke="${escape(r.id)}">Cancel credit — player chose refund</button></p>`:'<p>Only an owner or court owner can cancel this credit.</p>'}`}</div></div>`).join('')}<p>Cancel an available credit before refunding the player, so they cannot get both.</p>`;
  }
  if(typeof module!=='undefined') module.exports={markup,openMarkup,revokedDetails};
  if(!root) return;
  const canRevoke=()=>['owner','court_owner'].includes(Auth.getSession()?.role);
  // The server re-checks role, credit state and reason before cancelling.
  function revokeCredit(item,onDone){
    const dialog=document.createElement('dialog');dialog.className='wx-dialog';
    dialog.innerHTML=`<form class="wx-dialog-inner"><h2>Cancel weather credit</h2><p>${escape(item.ref)} · Original ${escape(schedule(item.oldDate,item.oldSlots))}</p><p>Use this when the player chose a refund instead of a new time. Their reschedule link for this booking stops working and they receive an email. This cannot be undone and does not send money.</p><label class="wx-field">Required reason<textarea name="reason" minlength="10" maxlength="1000" required rows="3" placeholder="Player requested a refund via GCash on …"></textarea></label><label class="wx-field">Refund amount (optional)<input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal"></label><label class="wx-field">Refund reference (optional)<input name="reference" maxlength="120" placeholder="GCash or bank reference number"></label><p role="alert"></p><div class="wx-dialog-footer"><button type="button" class="btn btn-g">Go back</button><button type="submit" class="btn btn-p">Cancel credit</button></div></form>`;
    document.body.append(dialog);dialog.showModal();
    dialog.querySelector('button[type=button]').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>dialog.remove());
    dialog.querySelector('form').onsubmit=async event=>{
      event.preventDefault();const form=event.target,submit=form.querySelector('button[type=submit]');submit.disabled=true;
      try{
        const amount=form.elements.amount.value.trim();
        await WeatherAPI.call('revoke_weather_credit',{p_item_id:item.id,p_reason:form.elements.reason.value.trim(),p_refund_reference:form.elements.reference.value.trim()||null,p_refund_amount:amount?Number(amount):null});
        WeatherAPI.dispatch().catch(()=>{});
        dialog.close();await onDone();
      }catch(error){form.querySelector('[role=alert]').textContent=error.message;submit.disabled=false;}
    };
  }
  async function mountOpen(container,refs){
    const rows=await WeatherAPI.call('get_weather_open_credits',{p_refs:refs});
    container.innerHTML=openMarkup(rows,canRevoke());
    container.onclick=event=>{
      const button=event.target.closest('[data-weather-revoke]');
      const item=button&&rows.find(r=>r.id===button.dataset.weatherRevoke);
      if(item&&canRevoke()) revokeCredit(item,()=>mountOpen(container,refs));
    };
  }
  async function mount(container,rows){
    const owner=Auth.getSession()?.role==='owner';
    container.innerHTML=markup(rows,owner);
    container.onclick=event=>{
      const button=event.target.closest('[data-weather-refund]');
      if(!button || !owner) return;
      const item=rows.find(r=>r.id===button.dataset.weatherRefund);
      if(!item) return;
      const dialog=document.createElement('dialog');dialog.className='wx-dialog';
      dialog.innerHTML=`<form class="wx-dialog-inner"><h2>Authorize refund exception</h2><p>${escape(item.ref)} · Weather reschedule used</p><p>This records your exception to the refund block. It does not issue a payment.</p><label class="wx-field">Required reason<textarea name="reason" minlength="10" maxlength="1000" required rows="4"></textarea></label><p role="alert"></p><div class="wx-dialog-footer"><button type="button" class="btn btn-g">Cancel</button><button type="submit" class="btn btn-p">Record system-owner exception</button></div></form>`;
      document.body.append(dialog);dialog.showModal();
      dialog.querySelector('button[type=button]').onclick=()=>dialog.close();
      dialog.addEventListener('close',()=>dialog.remove());
      dialog.querySelector('form').onsubmit=async event=>{
        event.preventDefault();const submit=dialog.querySelector('button[type=submit]');submit.disabled=true;
        try{
          await WeatherAPI.call('authorize_weather_refund_override',{p_item_id:item.id,p_reason:dialog.querySelector('textarea').value.trim()});
          const refreshed=await WeatherAPI.call('get_weather_refund_status',{p_refs:[...new Set(rows.map(r=>r.ref))]});
          await mount(container,refreshed);dialog.close();
        }catch(error){dialog.querySelector('[role=alert]').textContent=error.message;submit.disabled=false;}
      };
    };
  }
  root.WeatherRefund={mount,revokeCredit,revokedDetails,async load(container,refs){
    container.innerHTML='<div data-weather-used>Checking weather reschedule history…</div><div data-weather-open></div>';
    const used=container.querySelector('[data-weather-used]'),open=container.querySelector('[data-weather-open]');
    await Promise.all([
      WeatherAPI.call('get_weather_refund_status',{p_refs:refs}).then(rows=>mount(used,rows),()=>{used.textContent='Weather refund status unavailable. Do not authorize a refund until this check succeeds.';}),
      mountOpen(open,refs).catch(()=>{open.textContent='Weather credit status unavailable. Do not refund until this check succeeds.';}),
    ]);
  }};
})(typeof window==='undefined'?null:window);

// Independent of the closure calendar: all-date, server-filtered credit history.
(function(root){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={used:'Used',available:'Available',cancelled:'Cancelled',changed:'Changed by owner',revoked:'Cancelled — refunded'};
  const refunds={blocked:'Refund blocked — weather reschedule used',exception:'System-owner refund exception authorized',normal_policy:'Normal refund policy applies — no used weather credit',credit_revoked:'Weather credit cancelled — player chose a refund'};
  const schedule=(date,slots)=>date?`${date} · ${(slots||[]).map(h=>`${Number(h)%12||12}${Number(h)<12?'am':'pm'}`).join(', ')}`:'Not rescheduled';
  const revokedDetails=(root?root.WeatherRefund:module.exports).revokedDetails;
  function rowsMarkup(rows,canRevoke){return rows.map(r=>`<article class="wx-row"><div><strong>${esc(r.name)}</strong><p>${esc(r.ref)} · ${esc(r.court)}</p><span class="wx-status">${esc(labels[r.status]||r.status)}</span><p>Original: ${esc(schedule(r.oldDate,r.oldSlots))}<br>Replacement: ${esc(schedule(r.newDate,r.newSlots))}</p>${r.usedAt?`<p>Used: ${esc(new Date(r.usedAt).toLocaleString('en-PH',{timeZone:'Asia/Manila'}))} PH</p>`:''}<strong>${esc(refunds[r.refundStatus]||'Refund status unavailable')}</strong>${r.status==='revoked'?revokedDetails(r):''}</div><div class="wx-row-actions"><button type="button" class="wx-button" data-credit-ref="${esc(r.ref)}">Booking details</button>${r.status==='available'&&canRevoke?`<button type="button" class="wx-button" data-credit-revoke="${esc(r.id)}">Cancel credit — player chose refund</button>`:''}</div></article>`).join('');}
  if(typeof module!=='undefined') module.exports.creditRowsMarkup=rowsMarkup;
  if(!root) return;
  root.WeatherCredits={init(container){
    if(container.dataset.ready)return;container.dataset.ready='true';
    container.innerHTML='<h3>Weather Credits</h3><p class="wx-subtitle">All players across all dates. Used credits appear newest first. The court closure date above does not filter this history.</p><div class="wx-toolbar"><label class="wx-field">Search players or booking reference<input type="search" data-credit-search maxlength="200" placeholder="Player name or booking reference"></label><label class="wx-field">Credit status<select data-credit-status><option value="used">Used credits</option><option value="all">All credits</option><option value="available">Available credits</option><option value="cancelled">Cancelled credits</option><option value="changed">Changed by owner</option><option value="revoked">Cancelled — refunded</option></select></label><button class="wx-button" type="button" data-credit-refresh>Refresh credits</button></div><p data-credit-summary role="status" aria-live="polite"></p><div data-credit-rows></div><div class="wx-toolbar"><button class="wx-button" type="button" data-credit-prev>Previous</button><button class="wx-button" type="button" data-credit-next>Next</button></div>';
    const get=selector=>container.querySelector(selector);let offset=0,total=0,ticket=0,timer,items=[];const canRevoke=['owner','court_owner'].includes(Auth.getSession()?.role);
    async function load(){const current=++ticket;get('[data-credit-summary]').textContent='Loading weather credits…';get('[data-credit-rows]').innerHTML='';get('[data-credit-prev]').disabled=true;get('[data-credit-next]').disabled=true;
      try{const data=await WeatherAPI.call('get_weather_credits',{p_search:get('[data-credit-search]').value.trim(),p_status:get('[data-credit-status]').value,p_offset:offset});if(current!==ticket)return;total=Number(data.total)||0;items=data.items||[];get('[data-credit-rows]').innerHTML=rowsMarkup(items,canRevoke);get('[data-credit-summary]').textContent=total?`${offset+1}–${Math.min(offset+50,total)} of ${total} credits · all dates`:'No matching weather credits across all dates.';get('[data-credit-prev]').disabled=offset===0;get('[data-credit-next]').disabled=offset+50>=total;
      }catch(error){if(current!==ticket)return;get('[data-credit-summary]').textContent='Could not load weather credits. Use Refresh credits to retry.';}
    }
    get('[data-credit-search]').addEventListener('input',()=>{clearTimeout(timer);++ticket;offset=0;timer=setTimeout(load,250);});
    get('[data-credit-status]').addEventListener('change',()=>{clearTimeout(timer);offset=0;load();});
    get('[data-credit-refresh]').onclick=()=>{clearTimeout(timer);offset=0;load();};
    get('[data-credit-prev]').onclick=()=>{offset=Math.max(0,offset-50);load();};
    get('[data-credit-next]').onclick=()=>{offset+=50;load();};
    get('[data-credit-rows]').onclick=event=>{const revoke=event.target.closest('[data-credit-revoke]'),item=revoke&&items.find(r=>r.id===revoke.dataset.creditRevoke);if(item&&canRevoke)return root.WeatherRefund.revokeCredit(item,load);const button=event.target.closest('[data-credit-ref]');if(button)openBookingDetails(button.dataset.creditRef);};
    load();
  }};
})(typeof window==='undefined'?null:window);
