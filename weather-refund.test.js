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

test('booking details offer credit cancellation only to owners and keep the cancellation record',()=>{
 const {openMarkup}=require('./weather-refund.js');
 const available={id:'c1',ref:'PB-A',court:'Court 1',status:'available',oldDate:'2026-11-02',oldSlots:['18']};
 assert.match(openMarkup([available],true),/data-weather-revoke="c1"/);
 assert.doesNotMatch(openMarkup([available],false),/data-weather-revoke/);
 assert.equal(openMarkup([],true),'');
 const revoked=openMarkup([{...available,status:'revoked',revokeReason:'<b>GCash refund</b>',refundAmount:450,refundReference:'GC-123',revokedBy:'Owner A',revokedAt:'2026-11-02T03:00:00Z'}],true);
 assert.match(revoked,/player chose a refund/);assert.match(revoked,/&lt;b&gt;GCash refund/);assert.match(revoked,/₱450\.00/);assert.match(revoked,/GC-123/);assert.doesNotMatch(revoked,/data-weather-revoke|<b>/);
});

test('credit history shows the cancel action on available credits and the refund record on revoked ones',()=>{
 const {creditRowsMarkup}=require('./weather-refund.js');
 const rows=[{id:'a',ref:'PB-A',name:'A',status:'available',refundStatus:'normal_policy'},{id:'r',ref:'PB-R',name:'R',status:'revoked',refundStatus:'credit_revoked',revokeReason:'Refund sent via GCash',revokedAt:'2026-11-02T03:00:00Z'}];
 const owner=creditRowsMarkup(rows,true);
 assert.match(owner,/data-credit-revoke="a"/);assert.doesNotMatch(owner,/data-credit-revoke="r"/);assert.match(owner,/Cancelled — refunded/);assert.match(owner,/Refund sent via GCash/);
 assert.doesNotMatch(creditRowsMarkup(rows,false),/data-credit-revoke/);
});
