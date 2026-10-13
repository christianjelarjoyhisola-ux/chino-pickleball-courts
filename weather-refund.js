(function(root){
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const when = value => value ? new Date(value).toLocaleString('en-PH',{timeZone:'Asia/Manila'})+' PH' : '—';
  const schedule = (date,slots) => `${date || '—'} · ${(slots||[]).map(h=>`${h}:00`).join(', ')}`;
  function markup(rows,owner){
    if(!rows.length) return '';
    return `<h3>Weather reschedule used</h3>${rows.map(r=>`<div class="booking-detail-section wx-row"><div><strong>${escape(r.court || r.ref)}</strong><p>${escape(r.ref)}</p><p>Original: ${escape(schedule(r.oldDate,r.oldSlots))}<br>Replacement: ${escape(schedule(r.newDate,r.newSlots))}</p><p>Used: ${escape(when(r.usedAt))}</p><strong>${r.overrideAt?'System-owner refund exception authorized':'Refund blocked — weather reschedule used'}</strong>${r.overrideAt?`<p>${escape(r.overrideReason)}</p><p>${escape(r.overrideBy || 'System owner')} · ${escape(when(r.overrideAt))}</p>`:owner?`<p><button type="button" class="btn btn-g" data-weather-refund="${escape(r.id)}">Authorize refund exception</button></p>`:'<p>Only the system owner can override with a recorded reason.</p>'}</div></div>`).join('')}<p>An exception does not send money or mark a refund as paid.</p>`;
  }
  if(typeof module!=='undefined') module.exports={markup};
  if(!root) return;
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
  root.WeatherRefund={mount,async load(container,refs){
    container.textContent='Checking weather reschedule history…';
    try{await mount(container,await WeatherAPI.call('get_weather_refund_status',{p_refs:refs}));}
    catch(error){container.textContent='Weather refund status unavailable. Do not authorize a refund until this check succeeds.';}
  }};
})(typeof window==='undefined'?null:window);
