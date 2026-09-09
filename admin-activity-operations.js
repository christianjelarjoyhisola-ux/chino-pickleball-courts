(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChinoActivityOperations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // This is a catalog of controls, not evidence that an operation succeeded.
  // Labels are fixed application text. Never read customer text or field values.
  const handlers = {
    refreshCourtActivity: 'Refresh court activity',
    renderMaintFee: 'Refresh platform allocation',
    togglePlatformCourtBreakdown: 'Show or hide allocation by court',
    renderPaddleInsights: 'Refresh Insights',
    selectPaddleInsightMobileCell: 'View booking demand for an hour',
    selectPaddleInsightDesktopCell: 'View booking demand for an hour',
    jumpPaddleInsightMobilePeriod: 'View another time of day in the demand map',
    copyPaddleInsightAction: 'Copy the suggested court post',
    switchBookingView: 'Change the bookings view',
    setBookingStatusView: 'Filter bookings by status',
    bookingFiltersChanged: 'Change booking filters',
    clearFilters: 'Clear booking filters',
    setBookingPageSize: 'Change the number of bookings per page',
    changeBookingPage: 'View another page of bookings',
    exportCSV: 'Download bookings as a spreadsheet',
    openAvailabilityGraphic: 'Open the availability post creator',
    calNav: 'View another calendar month',
    calDayClick: 'View a day on the booking calendar',
    calOpenBookingSlot: 'Start a booking for an available court hour',
    calViewDayBookings: 'View bookings for the selected day',
    calClearDaySelection: 'Close the calendar day details',
    renderDeletedBookings: 'Refresh deleted bookings',
    restoreDeletedBooking: 'Restore a deleted booking',
    refreshPaymentReview: 'Refresh the payment review list',
    renderPaymentReview: 'Change payment review filters',
    reviewPendingHostBalances: 'Open unpaid host balances',
    exportReportCSV: 'Download the revenue report as a spreadsheet',
    setReportPeriod: 'Change the report period',
    setReportBreakdown: 'Change the revenue breakdown',
    openBookingDetails: 'Open booking details',
    closeBookingDetails: 'Close booking details',
    openOwnerBookingPreview: 'Preview the player booking page',
    openHostPaymentHistory: 'Open booking payment history',
    openHostPaymentHistoryFromDetails: 'Open booking payment history',
    openVerifyModal: 'Open the booking receipt review',
    closeVerifyModal: 'Close the booking receipt review',
    quickConfirmBooking: 'Confirm booking payment received',
    verifyAndConfirm: 'Confirm booking payment received',
    updateStatus: 'Change the booking status',
    updatePaymentStatus: 'Change the booking payment status',
    restoreForfeitedHostBooking: 'Restore a forfeited host booking as fully paid',
    resendConfirmationEmail: 'Resend the booking confirmation email',
    resendHostBalanceNotice: 'Send a host balance or forfeiture notice',
    delBooking: 'Delete a booking',
    rejectPayment: 'Open the payment rejection form',
    openBookingPaymentRejectModal: 'Open the payment rejection form',
    closeBookingPaymentRejectModal: 'Close without rejecting payment',
    confirmBookingPaymentRejection: 'Reject payment and request an email to the player',
    resendBookingRejectionEmail: 'Resend the payment rejection email',
    openBookingPaymentTransferModal: 'Review moving a payment to a replacement booking',
    openDuplicatePaymentTransferFromVerify: 'Review moving a payment to a replacement booking',
    closeBookingPaymentTransferModal: 'Close without moving payment',
    viewDuplicatePaymentSource: 'Open the old booking for this payment',
    confirmBookingPaymentTransfer: 'Move the payment and confirm the replacement booking',
    resendBookingPaymentTransferEmail: 'Resend the payment move email',
    openOpVerifyModal: 'Open the Open Play receipt review',
    openHostSessionVerifyModal: 'Open the hosted Open Play receipt review',
    confirmOpPayment: 'Confirm Open Play payment received',
    rejectOpPayment: 'Mark Open Play payment as not received',
    openNewBookingModal: 'Start a booking for a customer',
    nbRenderSlots: 'Check available hours for a new booking',
    nbToggleCourt: 'Select or remove a court for a new booking',
    nbToggleSlot: 'Select or remove a booking hour',
    nbToggleRef: 'Choose the new booking payment method',
    saveNewBooking: 'Create the customer booking',
    openRescheduleModal: 'Open the booking reschedule form',
    closeRescheduleModal: 'Close without rescheduling the booking',
    loadRsAvailability: 'Check available hours for rescheduling',
    updateRsEndTime: 'Choose a new booking time',
    saveReschedule: 'Save the new schedule and request a player email',
    openGroupRescheduleModal: 'Open the grouped booking reschedule form',
    closeGroupRescheduleModal: 'Close without rescheduling the bookings',
    grsToggleAll: 'Select or clear all schedules to move',
    grsToggleItem: 'Select or remove a schedule to move',
    grsApplyBulkDate: 'Choose the new date for selected schedules',
    grsChangeDate: 'Choose a new date for one schedule',
    grsUpdateSelection: 'Choose a new time for one schedule',
    grsChooseTime: 'Choose a new time for the selected schedules',
    grsLoadAvailability: 'Retry loading available reschedule hours',
    saveGroupReschedule: 'Save selected schedules and request a player email',
    openBookingRescheduleRequests: 'Open player reschedule requests',
    closeBookingRescheduleRequests: 'Close player reschedule requests',
    selectBookingRescheduleRequest: 'Open a player reschedule request',
    setBookingRescheduleRequestView: 'Change the reschedule request list',
    refreshBookingRescheduleRequests: 'Refresh player reschedule requests',
    reviewBookingRescheduleRequest: 'Decide on a player reschedule request',
    retryBookingRescheduleNotifications: 'Retry sending the reschedule decision email',
  };

  const controls = [];
  function add(selector, action, label, page, event = 'click') {
    controls.push({ selector, action, label, ...(page ? { page } : {}), event });
  }
  function change(selector, action, label, page) { add(selector, action, label, page, 'change'); }

  add('#courtActivityBody button[data-activity-ref]', 'court_activity_booking_details', 'Open booking details from court activity', 'dash');
  add('#courtActivityBody .ca-more > summary', 'court_activity_more', 'Show or hide more scheduled players', 'dash');
  change('#prInsightCourt', 'insights_court_filter', 'Filter Insights by court', 'insights');
  add('#prInsightRefresh', 'insights_refresh', 'Refresh Insights', 'insights');
  add('#sec-insights .pr-insights-method > summary', 'insights_explanation_toggle', 'Show or hide how Insights works', 'insights');
  add('#viewBtnList', 'booking_view_list', 'View bookings as a list', 'bookings');
  add('#viewBtnCal', 'booking_view_calendar', 'View bookings on the calendar', 'bookings');
  for (const [status, label] of Object.entries({ all: 'Show bookings with any status', pending: 'Show pending bookings', confirmed: 'Show confirmed bookings', completed: 'Show completed bookings', closed: 'Show cancelled or rejected bookings' })) {
    add(`[data-booking-status="${status}"]`, `booking_status_${status}`, label, 'bookings');
  }
  change('#srch', 'bookings_search', 'Search bookings', 'bookings');
  change('#fDate', 'bookings_date_filter', 'Filter bookings by court date', 'bookings');
  change('#fPayment', 'bookings_payment_filter', 'Filter bookings by payment status', 'bookings');
  add('#bookingPrev', 'bookings_previous_page', 'View the previous page of bookings', 'bookings');
  add('#bookingNext', 'bookings_next_page', 'View the next page of bookings', 'bookings');
  add('#calendarView .cal-nav-btn:first-child', 'bookings_previous_month', 'View the previous calendar month', 'bookings');
  add('#calendarView .cal-nav-btn:last-child', 'bookings_next_month', 'View the next calendar month', 'bookings');
  add('.mb-book-pay > summary', 'booking_actions_toggle', 'Show or hide booking actions');
  change('#deletedSrch', 'deleted_bookings_search', 'Search deleted bookings', 'deleted');
  change('#deletedStatus', 'deleted_bookings_status_filter', 'Filter deleted bookings by archive status', 'deleted');
  change('#prSearch', 'payment_review_search', 'Search payments for review', 'payreview');
  change('#prType', 'payment_review_type_filter', 'Filter payments by booking type', 'payreview');
  change('#prStatus', 'payment_review_status_filter', 'Filter payments by review status', 'payreview');
  add('#sec-payreview .pr-log-panel > summary', 'payment_review_log_toggle', 'Show or hide the recent payment log', 'payreview');
  for (const [period, label] of Object.entries({ week: 'View this week’s revenue report', month: 'View this month’s revenue report', all: 'View the revenue report for all dates', custom: 'Choose a custom report period' })) {
    add(`#rp-${period}`, `report_period_${period}`, label, 'reports');
  }
  change('#rpFrom', 'report_start_date', 'Choose the report start date', 'reports');
  change('#rpTo', 'report_end_date', 'Choose the report end date', 'reports');
  for (const [tab, label] of Object.entries({ court: 'View revenue by court', payment: 'View revenue by payment method', received: 'View received payments', trend: 'View the revenue trend' })) {
    add(`[data-rp-tab="${tab}"]`, `report_breakdown_${tab}`, label, 'reports');
  }
  add('#sec-reports details > summary', 'report_transactions_toggle', 'Show or hide report transaction details', 'reports');

  // The same dialogs can be opened from several pages. Do not hard-code their
  // page: the observer keeps the page from which the operator opened them.
  add('#bookingDetailsActions button[onclick*="openVerifyModal"]', 'booking_details_payment_review', 'Open the booking receipt review');
  add('#vmReceiptLink', 'booking_full_receipt', 'Open the full booking receipt');
  add('#ovReceiptLink', 'open_play_full_receipt', 'Open the full Open Play receipt');
  change('#bookingPaymentRejectReason', 'payment_rejection_reason_edit', 'Edit the payment rejection reason');
  change('#bookingPaymentTransferReason', 'payment_move_reason_edit', 'Edit the reason for moving payment');
  change('#bookingPaymentTransferNoRefund', 'payment_move_check', 'Change the player and refund confirmation');
  add('#opVerifyModal .m-x, #ovResolvedClose', 'open_play_review_close', 'Close the Open Play receipt review');
  add('#newBookingModal .m-x, #newBookingModal .m-foot .btn-g', 'new_booking_close', 'Close without creating a booking');
  for (const [id, action, label] of [
    ['nbName', 'name', 'Edit the new booking customer name'],
    ['nbPhone', 'phone', 'Edit the new booking contact number'],
    ['nbEmail', 'email', 'Edit the new booking customer email'],
    ['nbDate', 'date', 'Choose the new booking date'],
    ['nbCourt', 'court', 'Choose a court for the new booking'],
    ['nbMethod', 'method', 'Choose the new booking payment method'],
    ['nbGcashRef', 'payment_reference', 'Edit the new booking payment reference'],
    ['nbStatus', 'status', 'Choose the new booking status'],
  ]) change(`#${id}`, `new_booking_${action}`, label);
  change('#rsNewDate', 'reschedule_date', 'Choose the new booking date');
  change('#rsStartTime', 'reschedule_time', 'Choose the new booking time');
  change('#rsNote', 'reschedule_note', 'Edit the reschedule note for the player');
  change('#grsNote', 'group_reschedule_reason', 'Edit the reason for rescheduling bookings');
  change('#brqDecisionReason', 'reschedule_decision_note', 'Edit the reschedule decision note');
  add('#brqPendingTab', 'reschedule_requests_pending', 'View pending reschedule requests');
  add('#brqHistoryTab', 'reschedule_requests_history', 'View past reschedule decisions');
  add('#brqRejectBtn', 'reschedule_request_decline', 'Decline the player’s reschedule request');
  add('#brqApproveBtn', 'reschedule_request_approve', 'Approve the player’s requested schedule');

  // Delegated controls in the availability graphic studio have no inline handler.
  for (const [action, label] of Object.entries({ close: 'Close the availability post creator', refresh: 'Refresh availability for the post', 'previous-page': 'Preview the previous availability image', 'next-page': 'Preview the next availability image', copy: 'Copy the availability post caption', share: 'Open sharing for the availability post', download: 'Download the availability post images' })) {
    add(`[data-prag-action="${action}"]`, `availability_post_${action.replace(/-/g, '_')}`, label);
  }
  change('[data-prag-date]', 'availability_post_date', 'Choose the date for the availability post');
  change('[data-prag-court]', 'availability_post_court', 'Select or remove a court from the availability post');
  add('[data-prag-format="feed"]', 'availability_post_feed', 'Use the social post image format');
  add('[data-prag-format="story"]', 'availability_post_story', 'Use the social story image format');

  // Payment-history controls are built by host-balance-admin.js.
  add('#hostBalanceAdminPanel .hba-head button', 'host_balance_queue_refresh', 'Refresh host balance payments', 'payreview');
  add('#hostBalanceAdminList .hba-bottom button', 'host_balance_queue_review', 'Open the host booking payment history', 'payreview');
  add('#hostBalanceReviewModal .hba-close', 'host_balance_history_close', 'Close booking payment history');
  add('#hostDepositTab', 'host_deposit_view', 'View Payment 1: the reservation deposit');
  add('#hostBalanceTab', 'host_balance_view', 'View Payment 2: the remaining balance');
  add('#hostDepositProofLink', 'host_deposit_receipt', 'Open the full deposit receipt');
  add('#hostBalanceProofLink', 'host_balance_receipt', 'Open the full balance receipt');
  change('#hostBalanceReviewReason', 'host_balance_review_reason', 'Edit the reason for rejecting the balance payment');
  add('#hostBalanceRejectBtn', 'host_balance_reject', 'Mark the balance payment as not received');
  add('#hostBalanceApproveBtn', 'host_balance_approve', 'Confirm the balance payment received');

  // Read labels are available for explicitly requested reads. Background reads
  // must not be presented as deliberate operator actions merely because they run.
  const operations = {
    getCourtActivityBookings: 'Load the court activity schedule',
    getInsightInputs: 'Load the data used by Insights',
    getAvailabilityGraphic: 'Load court availability for a post',
    getAvailabilityGraphicSnapshot: 'Load the current court availability for a post',
    getBookings: 'Load bookings',
    getBookingByRef: 'Load booking details',
    getDeletedBookingArchive: 'Load deleted bookings',
    getAdminRescheduleOptions: 'Load available hours for rescheduling',
    getAdminRescheduleHistory: 'Load the booking’s past schedule changes',
    listBookingRescheduleRequests: 'Load player reschedule requests',
    getBookingRescheduleRequest: 'Load a player reschedule request',
    getReceiptSignedUrl: 'Load the booking receipt',
    getOpenPlayReceiptSignedUrl: 'Load the Open Play receipt',
    getHostSessionReceiptSignedUrl: 'Load the hosted Open Play receipt',
    getBookingBalanceNotifications: 'Load host balance notification history',
    addBooking: 'Create a booking',
    addBookings: 'Create the customer’s bookings',
    updateBooking: 'Update a booking',
    deleteBooking: 'Delete a booking',
    voidDeleteBookingGroup: 'Delete the booking group and retain its audit record',
    confirmBookingTransaction: 'Confirm booking payment received',
    rejectBookingPaymentTransaction: 'Reject the submitted booking payment',
    transferCancelledBookingPayment: 'Move payment to the replacement booking',
    restoreDeletedBookingArchive: 'Restore a deleted booking',
    markHostBookingGroupFullyPaid: 'Mark the host booking as fully paid',
    restoreForfeitedHostBookingAsFullyPaid: 'Restore the forfeited booking as fully paid',
    rescheduleBookingTransaction: 'Save the new booking schedule',
    rescheduleBookingsTransaction: 'Save the selected booking schedules',
    reviewBookingRescheduleRequest: 'Save the reschedule request decision',
    sendConfirmationEmail: 'Send the booking confirmation email',
    sendRescheduleEmail: 'Send the new booking schedule by email',
    sendGroupedRescheduleEmail: 'Send the selected booking schedules by email',
    sendBookingStatusEmail: 'Send the booking status email',
    sendHostBalanceNotice: 'Send a host balance or forfeiture notice',
    dispatchBookingRescheduleNotifications: 'Check for reschedule decision emails to send',
    updateOpenPlayRegistration: 'Update an Open Play registration',
    updateOpenPlayHostSessionRegistration: 'Update a hosted Open Play registration',
  };
  // These are known destinations, never inferred from customer content or the
  // first visible dialog. A result is "Opened" only after this panel is visible.
  const panels = {
    openBookingDetails: '#bookingDetailsModal',
    openHostPaymentHistory: '#hostBalanceReviewModal',
    openHostPaymentHistoryFromDetails: '#hostBalanceReviewModal',
    openVerifyModal: '#verifyModal',
    rejectPayment: '#bookingPaymentRejectModal',
    openBookingPaymentRejectModal: '#bookingPaymentRejectModal',
    openBookingPaymentTransferModal: '#bookingPaymentTransferModal',
    openDuplicatePaymentTransferFromVerify: '#bookingPaymentTransferModal',
    openOpVerifyModal: '#opVerifyModal',
    openHostSessionVerifyModal: '#opVerifyModal',
    openNewBookingModal: '#newBookingModal',
    calOpenBookingSlot: '#newBookingModal',
    openRescheduleModal: '#rescheduleModal',
    openGroupRescheduleModal: '#groupRescheduleModal',
    openBookingRescheduleRequests: '#bookingRescheduleRequestsModal',
    openCourtModal: '#courtModal',
    openAccModal: '#accModal',
  };
  return { handlers, controls, operations, panels };
});
