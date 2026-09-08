const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const admin=fs.readFileSync('admin.html','utf8');
test('history shows each court, old/new schedules and escaped multiline reason',()=>{
  const context=vm.createContext({fmtD:x=>x,fmtHour:x=>`${x}:00`,esc:x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')});
  vm.runInContext(admin.slice(admin.indexOf('function renderAdminRescheduleHistory('),admin.indexOf('async function openBookingDetails(')),context);
  const html=context.renderAdminRescheduleHistory([{booking_ref:'A',created_at:'2026-09-09T01:00:00Z',reason:'Rain\n<script>alert(1)</script>',old_schedule:{date:'2026-09-10',slots:['8','9']},new_schedule:{date:'2026-09-11',slots:['12','13']}}],[{ref:'A',courtName:'Court 2'}]);
  assert.match(html,/Court 2/);assert.match(html,/2026-09-10 · 8:00 – 10:00/);assert.match(html,/2026-09-11 · 12:00 – 14:00/);
  assert.match(html,/Rain\n&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
  assert.equal(context.renderAdminRescheduleHistory([],[]),'');
});
test('one reason field is visible before time choices',()=>{
  assert.equal((admin.match(/id="grsNote"/g)||[]).length,1);
  assert.ok(admin.indexOf('id="grsNote"')<admin.indexOf('id="grsSharedTimes"'));
  assert.match(admin,/Reason for rescheduling/);
});
