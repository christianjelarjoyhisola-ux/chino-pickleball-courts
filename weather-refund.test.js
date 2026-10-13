const test=require('node:test'),assert=require('node:assert/strict');
const {markup}=require('./weather-refund.js');
const used={id:'123',ref:'PB-TEST',oldDate:'2026-10-13',newDate:'2026-10-14',oldSlots:['19'],newSlots:['20'],usedAt:'2026-10-13T06:00:00Z'};
test('used history shows both schedules and refund block, with owner-only action',()=>{
 const staff=markup([used],false);assert.match(staff,/Weather reschedule used/);assert.match(staff,/Refund blocked/);assert.match(staff,/2026-10-14/);assert.doesNotMatch(staff,/data-weather-refund/);
 assert.match(markup([used],true),/data-weather-refund/);assert.equal(markup([],true),'');
});
test('authorized exception preserves used history, escapes its reason and removes authorization action',()=>{
 const result=markup([{...used,overrideAt:used.usedAt,overrideReason:'<script>bad</script>'}],true);
 assert.match(result,/Weather reschedule used/);assert.match(result,/exception authorized/);assert.match(result,/&lt;script&gt;/);assert.doesNotMatch(result,/data-weather-refund|<script>/);assert.match(result,/does not send money/);
});

test('all-date credit cards show player, schedules and refund status without implying unused credits are refundable',()=>{
 const {creditRowsMarkup}=require('./weather-refund.js');
 const html=creditRowsMarkup([{ref:'PB-X',name:'<Player>',court:'Court 1',status:'used',oldDate:'2026-09-21',oldSlots:['19'],newDate:'2026-10-14',newSlots:['20'],usedAt:'2026-10-14T01:00:00Z',refundStatus:'blocked'},{ref:'PB-Y',name:'Other',status:'available',refundStatus:'normal_policy'}]);
 assert.match(html,/&lt;Player&gt;/);assert.match(html,/2026-09-21/);assert.match(html,/2026-10-14/);assert.match(html,/Refund blocked/);assert.match(html,/Normal refund policy applies/);assert.match(html,/Booking details/);assert.doesNotMatch(html,/<Player>/);
});
