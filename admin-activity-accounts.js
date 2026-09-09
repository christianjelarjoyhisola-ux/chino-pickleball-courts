(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChinoActivityAccounts = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  // These are fixed control names, not text entered by an operator. A control
  // records a request; its completion must come from a separate result record.
  const handlers = {
    renderAccounts: 'Refresh host accounts',
    openAccModal: 'Open account editor',
    saveAcc: 'Save account',
    delAcc: 'Delete account',
    openHostAccountDetails: 'Open host bookings and balance',
    closeHostAccountDetails: 'Close host bookings and balance',
    refreshHostAccountDetails: 'Refresh host bookings and balance',
    setHostAccountFilter: 'Filter host bookings',
    updateHostAccountSearch: 'Search host bookings',
    openHostFinanceBooking: 'Open a host booking',
    renderHostCenter: 'Refresh host sessions and applications',
    hostResetForm: 'Clear host session form',
    editHostSession: 'Edit host session',
    saveHostSession: 'Save host session',
    cancelHostSession: 'Cancel host session',
    hostCopy: 'Copy host session share link',
    reviewHostApplication: 'Review host application',
    repairHostApplicationActivation: 'Check or repair host login',
    openHostValidId: 'Open host ID',
    sendHostTelegramTest: 'Send a test Telegram message',
    renderRemittances: 'Refresh remittances',
    setRemittanceTab: 'Change remittance view',
    updateRemittanceStatusFilter: 'Filter remittances by status',
    openRemittancePrepare: 'Open remittance preparation',
    prepareRemittanceNow: 'Prepare remittance and freeze balance',
    openRemittancePayment: 'Open remittance payment form',
    copyRemittanceValue: 'Copy remittance payment details',
    handleRemittanceProof: 'Choose remittance receipt',
    submitRemittancePayment: 'Submit remittance payment proof',
    openRemittanceReview: 'Open remittance payment review',
    reviewRemittancePayment: 'Review remittance payment proof',
    openRemittanceDetails: 'Open remittance details',
    openRemittanceCancellation: 'Open remittance cancellation',
    submitRemittanceCancellation: 'Cancel prepared remittance and return balance',
    closeRemittanceModal: 'Close remittance window',
    toggleSidebar: 'Open or close page menu',
    toggleTheme: 'Switch light or dark appearance',
    openChangePwModal: 'Open password change form',
    saveNewPassword: 'Update own password',
    logout: 'Sign out',
    agreeClearSig: 'Clear agreement signature',
    agreeCheckReady: 'Change agreement confirmation',
    submitAgreement: 'Submit account agreement',
  };

  const controls = [
    // Existing host_account_* / host_bookings_* data-activity-action attributes
    // remain the first choice in the observer and are not duplicated here.
    { selector: '#sec-accounts .account-page-actions [onclick="openAccModal()"]', action: 'account_add_open', label: 'Open new account form', page: 'accounts', event: 'click' },
    { selector: '#accModal .m-x, #accModal .m-foot [onclick="closeModal(\'accModal\')"]', action: 'account_editor_close', label: 'Close account editor', page: 'accounts', event: 'click' },
    { selector: '#amFull', action: 'account_name_edit', label: 'Edit account name', page: 'accounts', event: 'change' },
    { selector: '#amUser', action: 'account_username_edit', label: 'Edit account username', page: 'accounts', event: 'change' },
    { selector: '#amEmail', action: 'account_email_edit', label: 'Edit account email', page: 'accounts', event: 'change' },
    { selector: '#amRole', action: 'account_role_edit', label: 'Choose account role', page: 'accounts', event: 'change' },

    { selector: '#sec-hosts .toolbar [onclick="hostResetForm()"]', action: 'host_center_session_new', label: 'Start a new host session', page: 'hosts', event: 'click' },
    { selector: '#sec-hosts .gm-actions [onclick="hostResetForm()"]', action: 'host_center_session_clear', label: 'Clear host session form', page: 'hosts', event: 'click' },
    { selector: '#hostApplicationList [onclick^="reviewHostApplication("][onclick*="\'approved\'"]', action: 'host_center_application_approve', label: 'Approve host application', page: 'hosts', event: 'click' },
    { selector: '#hostApplicationList [onclick^="reviewHostApplication("][onclick*="\'rejected\'"]', action: 'host_center_application_reject', label: 'Reject host application', page: 'hosts', event: 'click' },
    { selector: '#hostTitle', action: 'host_center_session_title', label: 'Edit host session title', page: 'hosts', event: 'change' },
    { selector: '#hostDate', action: 'host_center_session_date', label: 'Choose host session date', page: 'hosts', event: 'change' },
    { selector: '#hostStatus', action: 'host_center_session_status', label: 'Choose host session status', page: 'hosts', event: 'change' },
    { selector: '#hostStart', action: 'host_center_session_start', label: 'Choose host session start time', page: 'hosts', event: 'change' },
    { selector: '#hostEnd', action: 'host_center_session_end', label: 'Choose host session end time', page: 'hosts', event: 'change' },
    { selector: '#hostCourtList .host-court-cb', action: 'host_center_session_courts', label: 'Choose courts for host session', page: 'hosts', event: 'change' },
    { selector: '#hostMaxPlayers', action: 'host_center_session_capacity', label: 'Edit host session player limit', page: 'hosts', event: 'change' },
    { selector: '#hostFee', action: 'host_center_session_fee', label: 'Edit host session player fee', page: 'hosts', event: 'change' },
    { selector: '#hostPayment', action: 'host_center_session_payment_instructions', label: 'Edit host session payment instructions', page: 'hosts', event: 'change' },
    { selector: '#hostNotes', action: 'host_center_session_notes', label: 'Edit host session notes', page: 'hosts', event: 'change' },

    { selector: '#rmActiveTab', action: 'remittance_view_due', label: 'Show remittances still to pay', page: 'remittances', event: 'click' },
    { selector: '#rmHistoryTab', action: 'remittance_view_history', label: 'Show remittance history', page: 'remittances', event: 'click' },
    { selector: '#rmStatusFilter', action: 'remittance_filter_status', label: 'Filter remittances by status', page: 'remittances', event: 'change' },
    { selector: '#rmPayModal [onclick="copyRemittanceValue(\'rmPayAccountNumber\')"]', action: 'remittance_copy_number', label: 'Copy remittance GCash number', page: 'remittances', event: 'click' },
    { selector: '#rmPayModal [onclick="copyRemittanceValue(\'rmPayAccountName\')"]', action: 'remittance_copy_name', label: 'Copy remittance account name', page: 'remittances', event: 'click' },
    { selector: '#rmPayModal [onclick="copyRemittanceValue(\'rmPayReferenceNote\')"]', action: 'remittance_copy_reference_note', label: 'Copy remittance reference note', page: 'remittances', event: 'click' },
    { selector: '#rmPayAmount', action: 'remittance_amount_edit', label: 'Enter remittance payment amount', page: 'remittances', event: 'change' },
    { selector: '#rmPaymentRef', action: 'remittance_reference_edit', label: 'Enter remittance transaction reference', page: 'remittances', event: 'change' },
    { selector: '#rmPaymentNote', action: 'remittance_note_edit', label: 'Edit remittance payment note', page: 'remittances', event: 'change' },
    { selector: '#rmPaymentProof', action: 'remittance_receipt_choose', label: 'Choose remittance receipt', page: 'remittances', event: 'change' },
    { selector: '#rmPayModal form', action: 'remittance_proof_submit', label: 'Submit remittance payment proof', page: 'remittances', event: 'submit' },
    { selector: '#rmAmountAccepted', action: 'remittance_accepted_amount_edit', label: 'Enter accepted remittance amount', page: 'remittances', event: 'change' },
    { selector: '#rmReviewNote', action: 'remittance_review_note_edit', label: 'Edit remittance review note', page: 'remittances', event: 'change' },
    { selector: '#rmApproveBtn', action: 'remittance_proof_approve', label: 'Confirm remittance as settled', page: 'remittances', event: 'click' },
    { selector: '#rmRejectBtn', action: 'remittance_proof_reject', label: 'Reject remittance payment proof', page: 'remittances', event: 'click' },
    { selector: '#rmReviewReceiptWrap a, #rmDetailBody a', action: 'remittance_receipt_open', label: 'Open full remittance receipt', page: 'remittances', event: 'click' },
    { selector: '#rmCancelReason', action: 'remittance_cancellation_reason_edit', label: 'Edit remittance cancellation reason', page: 'remittances', event: 'change' },
    { selector: '#rmCancelModal form', action: 'remittance_cancel_submit', label: 'Cancel prepared remittance and return balance', page: 'remittances', event: 'submit' },
    { selector: '#rmDetailActions [onclick*="openRemittancePayment("]', action: 'remittance_details_pay', label: 'Open remittance payment form', page: 'remittances', event: 'click' },
    { selector: '#rmDetailActions [onclick*="openRemittanceReview("]', action: 'remittance_details_review', label: 'Open remittance payment review', page: 'remittances', event: 'click' },
    { selector: '#rmDetailActions [onclick*="openRemittanceCancellation("]', action: 'remittance_details_cancel', label: 'Open remittance cancellation', page: 'remittances', event: 'click' },

    // Activity History itself is visible only to the system owner. Watching
    // explicit controls does not log the background requests that load this list.
    { selector: '[data-aa="refresh"]', action: 'activity_refresh', label: 'Refresh activity history', page: 'activity', event: 'click' },
    { selector: '[data-aa="fromDate"]', action: 'activity_filter_from_date', label: 'Choose activity start date', page: 'activity', event: 'change' },
    { selector: '[data-aa="toDate"]', action: 'activity_filter_to_date', label: 'Choose activity end date', page: 'activity', event: 'change' },
    { selector: '[data-aa="actor"]', action: 'activity_filter_operator', label: 'Choose activity operator', page: 'activity', event: 'change' },
    { selector: '[data-aa="category"]', action: 'activity_filter_category', label: 'Choose activity category', page: 'activity', event: 'change' },
    { selector: '[data-aa="page"]', action: 'activity_filter_page', label: 'Choose activity page', page: 'activity', event: 'change' },
    { selector: '[data-aa="view"]', action: 'activity_filter_view', label: 'Choose activity view', page: 'activity', event: 'change' },
    { selector: 'form[data-aa="filters"]', action: 'activity_filters_apply', label: 'Apply activity filters', page: 'activity', event: 'submit' },
    { selector: '[data-aa="reset"]', action: 'activity_filters_reset', label: 'Reset activity filters', page: 'activity', event: 'click' },
    { selector: '[data-aa="more"]', action: 'activity_load_older', label: 'Load older activity', page: 'activity', event: 'click' },
    { selector: '[data-aa-detail]', action: 'activity_details_open', label: 'Open activity details', page: 'activity', event: 'click' },
    { selector: '[data-aa="close"]', action: 'activity_details_close', label: 'Close activity details', page: 'activity', event: 'click' },
    { selector: '.aa-event-details > summary', action: 'activity_technical_details_toggle', label: 'Expand or collapse technical event details', page: 'activity', event: 'click' },

    { selector: '.admin-boot-reload', action: 'admin_reload', label: 'Reload admin workspace', event: 'click' },
    { selector: '.topnav .nav-brand', action: 'admin_public_site_open', label: 'Open public booking website', event: 'click' },
    { selector: '#pwModal .m-x, #pwModal .m-foot [onclick="closeModal(\'pwModal\')"]', action: 'account_password_form_close', label: 'Close password change form', event: 'click' },
  ];

  const operations = {
    createAccount: 'Create account',
    updateAccount: 'Update account',
    deleteAccount: 'Delete account',
    createOpenPlayHostSession: 'Create host session',
    updateOpenPlayHostSession: 'Update host session',
    updateOpenPlayHostSessionRegistration: 'Update host session registration',
    reviewOpenPlayHostApplication: 'Review host application',
    repairOpenPlayHostActivation: 'Check or repair host login',
    getOpenPlayHostIdSignedUrl: 'Request host ID access',
    sendOpenPlayHostTelegramTest: 'Send a test Telegram message',
    dispatchOpenPlayHostReviewNotifications: 'Check for host application review messages',
    prepareBookingFeeRemittance: 'Prepare remittance and freeze balance',
    submitBookingFeeRemittance: 'Submit remittance payment proof',
    reviewBookingFeeRemittancePayment: 'Review remittance payment proof',
    cancelBookingFeeRemittance: 'Cancel prepared remittance and return balance',
    approveHostBalancePayment: 'Confirm host balance received',
    rejectHostBalancePayment: 'Reject host balance payment',
    reviewHostBalancePayment: 'Review host balance payment',
    changePassword: 'Update own password',
    signIn: 'Sign in',
    signOut: 'Sign out',
  };

  // Only real modal destinations are included. Host session editing stays on
  // the page, and opening a host ID creates a new tab rather than a modal.
  const panels = {
    openAccModal: '#accModal',
    openHostAccountDetails: '#hostAccountModal',
    openChangePwModal: '#pwModal',
    openRemittancePrepare: '#rmPrepareModal',
    openRemittancePayment: '#rmPayModal',
    openRemittanceReview: '#rmReviewModal',
    openRemittanceDetails: '#rmDetailModal',
    openRemittanceCancellation: '#rmCancelModal',
  };

  return { handlers, controls, operations, panels };
});
