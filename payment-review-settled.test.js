const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('admin.html','utf8');
function status(row){const body=html.slice(html.indexOf('function bookingReviewStatus(b) {'),html.indexOf('function openPlayReviewStatus'));const scope={window:{ReceiptWorkflow:require('./receipt-workflow.js')},isDigitalPayment:()=>true,row};vm.createContext(scope);return vm.runInContext(body+'\nbookingReviewStatus(row)',scope);}
test('paid cancelled receipts remain paid manually confirmed, not rejected or awaiting review',()=>{
 const row={status:'cancelled',paymentMethod:'maribank',paymentStatus:'paid',receiptStatus:'manual_review',receiptImageUrl:'stored'};
 assert.equal(status(row),'paid_manual');assert.equal(row.status,'cancelled');
 assert.equal(status({...row,paymentStatus:'downpayment_paid'}),'deposit_manual');
 assert.equal(status({...row,receiptStatus:'auto_approved'}),'auto_approved');
 assert.equal(status({...row,paymentStatus:'rejected'}),'rejected');
 assert.equal(status({...row,status:'pending',paymentStatus:'for_verification'}),'manual_review');
});
