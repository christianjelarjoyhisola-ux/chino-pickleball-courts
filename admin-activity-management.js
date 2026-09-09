(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChinoActivityManagement = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Labels describe the requested action. A click or a draft edit never proves
  // that a setting was saved; the operation and database records supply results.
  const handlers = {
    openCourtModal: 'Open court editor',
    saveCourt: 'Save court details and pricing',
    toggleBlock: 'Pause or resume court bookings',
    delCourt: 'Delete court',
    saveVenueDetails: 'Save venue details',
    saveHours: 'Save opening and closing times',
    addTierRow: 'Add a pricing time range',
    removeTier: 'Remove a pricing time range',
    savePricingTiers: 'Save hourly pricing rules',
    saveAllCourtsPromo: 'Apply promo settings to all courts',
    addCourtTierRow: 'Add a court pricing time range',
    toggleTiersUI: 'Change the court pricing option',
    handleCourtPhoto: 'Choose a court photo',
    previewPhotoUrl: 'Edit the court photo link',
    renderIntegrationStatus: 'Check payment and notification connections',
    saveBookingFeePolicy: 'Save booking fee settings',
    savePlatformRemittance: 'Save the booking fee remittance account',
    handlePlatformQrUpload: 'Upload the remittance QR code',
    removePlatformQr: 'Remove the remittance QR code',
    handleQrUpload: 'Upload a payment QR code',
    removeQr: 'Remove a payment QR code',
    savePaymentSettings: 'Save payment methods and recipient details',
    mtAddRule: 'Add a maintenance rule to the draft',
    mtDeleteRule: 'Remove a maintenance rule from the draft',
    mtAddDateToRule: 'Add a date to the maintenance draft',
    mtRemoveDateFromRule: 'Remove a date from the maintenance draft',
    mtRuleModeChanged: 'Choose how the maintenance schedule repeats',
    saveMaintenance: 'Save maintenance rules',
    addBlocked: 'Block a booking date',
    removeBlocked: 'Unblock a booking date',
    opAddDate: 'Add an open play date to the draft',
    opRemoveDate: 'Remove an open play date from the draft',
    saveOpenPlay: 'Save open play settings',
    pmOpenFromReservations: 'Open paid players in Play Manager',
    gmOpenFromReservations: 'Open paid players in Play Manager',
    gmShowStage: 'Switch between play setup and live play',
    gmStartPlayFromSetup: 'Start live play',
    gmAdjustCourtCount: 'Change the number of courts in play',
    gmSetMode: 'Choose the player rotation style',
    gmHandleCourtChange: 'Change the courts in play',
    gmLoadSelectedSession: 'Open a play session',
    gmCreateOrOpenSession: 'Create or open a play session',
    gmSaveSessionMeta: 'Save play session settings',
    gmImportPaidPlayers: 'Import paid players',
    gmResetFromPaid: 'Replace the player list with paid players',
    gmSavePlayers: 'Save the player list',
    gmSetAllPlayerStatuses: 'Change all player check-ins',
    gmAddWalkIn: 'Add a walk-in player to the draft',
    gmRemovePlayerRow: 'Remove a player from the draft',
    gmGenerateNextRound: 'Start the next round',
    gmUndoRound: 'Undo the latest round',
    gmTogglePause: 'Pause or resume the play session',
    gmSetWinner: 'Record the match winner',
    gmSkipQueuePlayer: 'Move a player to the back of the queue',
    gmOpenDisplay: 'Open the venue display',
    gmCloseDisplay: 'Close the venue display',
    gmCopyOrder: 'Copy the full player order',
    gmCopyLiveUpdate: 'Copy a live play update',
    gmCopyManagerLink: 'Copy the play setup link',
    gmCopyReservationManagerLink: 'Copy the paid-player setup link',
    gmLoadPaste: 'Load a pasted player list or setup link',
    gmExportCsv: 'Download play standings as a spreadsheet',
    renderGameManager: 'Refresh Play Manager',
  };

  const controls = [];
  function control(selector, action, label, page, event = 'change', kind) {
    controls.push({ selector, action, label, ...(page ? { page } : {}), event, ...(kind ? { kind } : {}) });
  }
  function fields(entries, page) {
    for (const [id, label] of entries) control('#' + id, 'edit_' + id.toLowerCase(), label, page);
  }

  fields([
    ['venueAddressInput', 'Edit the venue address draft'],
    ['venueContactInput', 'Edit the venue contact number draft'],
    ['venueEmailInput', 'Edit the booking email draft'],
    ['venueDescriptionInput', 'Edit the venue description draft'],
    ['ohOpen', 'Choose a new opening time'],
    ['ohClose', 'Choose a new closing time'],
    ['allPromoEnabled', 'Change whether the all-court promo is enabled in the draft'],
    ['allPromoRate', 'Edit the all-court promo price draft'],
    ['allPromoStart', 'Choose the all-court promo start date'],
    ['allPromoEnd', 'Choose the all-court promo end date'],
  ], 'courts');
  control('#sec-courts a[href="index.html#venueContact"]', 'venue_public_details_open', 'Open the public venue details', 'courts', 'click');
  for (const [selector, label] of [
    ['#tiersBody .tier-from', 'Choose a pricing rule start time'],
    ['#tiersBody .tier-to', 'Choose a pricing rule end time'],
    ['#tiersBody .tier-rate', 'Edit an hourly pricing rule draft'],
    ['#cmTiersRows .tier-from', 'Choose a court pricing start time'],
    ['#cmTiersRows .tier-to', 'Choose a court pricing end time'],
    ['#cmTiersRows .tier-rate', 'Edit a court hourly price draft'],
  ]) control(selector, 'edit_' + selector.replace(/[^a-z0-9]+/gi, '_').toLowerCase(), label, undefined);
  control('#cmTiersRows button', 'court_pricing_range_remove', 'Remove a court pricing time range from the draft', undefined, 'click');
  fields([
    ['cmName', 'Edit the court name draft'],
    ['cmDesc', 'Edit the court description draft'],
    ['cmRate', 'Edit the default court price draft'],
    ['cmTiersEnabled', 'Change whether time-based court pricing is enabled in the draft'],
    ['cmPromoEnabled', 'Change whether the court promo is enabled in the draft'],
    ['cmPromoRate', 'Edit the court promo price draft'],
    ['cmPromoStartDate', 'Choose the court promo start date'],
    ['cmPromoEndDate', 'Choose the court promo end date'],
    ['cmPhotoFile', 'Choose a court photo'],
    ['cmPhotoUrl', 'Edit the court photo link draft'],
  ]);
  control('#courtModal .m-x, #courtModal .m-foot .btn-g', 'court_editor_close', 'Close the court editor', undefined, 'click');

  fields([
    ['bookingFeeModeInput', 'Choose how the booking fee is charged in the draft'],
    ['bookingFeeRateInput', 'Edit the booking fee draft'],
    ['platformGcashNumInput', 'Edit the remittance account number draft'],
    ['platformGcashNameInput', 'Edit the remittance account name draft'],
    ['platformGcashQrFile', 'Upload the remittance QR code'],
    ['gcashNumInput', 'Edit the GCash recipient number draft'],
    ['gcashNameInput', 'Edit the GCash recipient name draft'],
    ['gcashQrReceiptNameInput', 'Edit the GCash receipt alias draft'],
    ['gcashQrReceiptTokenInput', 'Edit the GCash QR destination draft'],
    ['gcashQrFile', 'Upload the GCash QR code'],
    ['pnbNumInput', 'Edit the PNB account number draft'],
    ['pnbNameInput', 'Edit the PNB account name draft'],
    ['pnbQrFile', 'Upload the PNB QR code'],
    ['securitybankNumInput', 'Edit the Security Bank account number draft'],
    ['securitybankNameInput', 'Edit the Security Bank account name draft'],
    ['securitybankQrFile', 'Upload the Security Bank QR code'],
    ['paymentAcceptanceModeSelect', 'Choose the customer payment policy'],
  ], 'payments');
  for (const [name, label] of [
    ['Cash', 'cash'], ['Gcash', 'GCash'], ['Bdopay', 'BDO Pay'], ['Maya', 'Maya'],
    ['Bpi', 'BPI'], ['Gotyme', 'GoTyme to GCash'], ['Maribank', 'MariBank to GCash'],
    ['Pnb', 'PNB'], ['Securitybank', 'Security Bank'],
  ]) control('#payMethod' + name + 'On', 'payment_method_' + name.toLowerCase() + '_edit', 'Change whether ' + label + ' payments are enabled in the draft', 'payments');
  for (const [id, label] of [['gcash', 'GCash'], ['pnb', 'PNB'], ['securitybank', 'Security Bank']]) {
    control('#' + id + 'QrPreviewWrap button', 'payment_qr_' + id + '_remove', 'Remove the ' + label + ' QR code', 'payments', 'click');
  }

  for (const [selector, action, label] of [
    ['[id^="mtEn_"]', 'maintenance_rule_enabled_edit', 'Change whether a maintenance rule is enabled in the draft'],
    ['input[class^="mt-cc-"]', 'maintenance_courts_edit', 'Choose which courts the maintenance rule affects'],
    ['[id^="mtLabel_"]', 'maintenance_block_type_edit', 'Choose the reason courts are blocked'],
    ['[id^="mtS_"]', 'maintenance_start_edit', 'Choose the maintenance start time'],
    ['[id^="mtE_"]', 'maintenance_end_edit', 'Choose the maintenance end time'],
    ['[id^="mtMode_"]', 'maintenance_repeat_edit', 'Choose how the maintenance schedule repeats'],
    ['[id^="mtNewDate_"]', 'maintenance_date_edit', 'Choose a maintenance date for the draft'],
    ['[id^="mtMonthDay_"]', 'maintenance_month_day_edit', 'Choose the monthly maintenance day'],
    ['[id^="mtDays_"] input', 'maintenance_week_days_edit', 'Choose the weekly maintenance days'],
  ]) control('#mtRulesList ' + selector, action, label, 'maintenance');

  const playActions = {
    'new-session': 'Open a new play session setup',
    'continue-live': 'Open live play',
    'edit-setup': 'Open play session settings',
    'sample-roster': 'Fill the draft with demo players',
    'import-paid': 'Import paid players',
    'replace-player': 'Open player replacement',
    'choose-players': 'Open the match player picker',
    'start-match': 'Start a match',
    'correct-winner': 'Open the match winner correction',
    'winner': 'Record the match winner',
    'skip-player': 'Move a player to the back of the queue',
    'add-player': 'Open the add-player form',
    'edit-player-skill': 'Open player details and skill level',
    'close-dialog': 'Close the play session dialog',
    'share-live': 'Open play session sharing',
    'copy-text-update': 'Copy a live play update',
    'copy-live-link': 'Copy the live play link',
    'native-share-live': 'Open the device sharing options',
    'rotate-live-link': 'Generate a new live play link',
    'disable-live-link': 'Disable the live play link',
    'export': 'Download play standings as a spreadsheet',
    'download-result': 'Download the final results image',
    'end-session': 'End the play session',
    'display': 'Switch the venue display on or off',
    'scroll': 'Jump to a live play section',
  };
  for (const [action, label] of Object.entries(playActions)) {
    control('[data-pm-action="' + action + '"]', 'play_' + action.replace(/-/g, '_'), label, 'gamemgr', 'click', ['export', 'download-result'].includes(action) ? 'export' : undefined);
  }
  for (const [target, label] of [
    ['pm2Courts', 'View the courts in play'], ['pm2Queue', 'View the player queue'],
    ['pm2Next', 'View the next matches'], ['pm2MatchLog', 'View the match history'],
  ]) {
    // Put the specific section control before the general scroll control.
    controls.unshift({ selector: '[data-pm-action="scroll"][data-target="' + target + '"]', action: 'play_view_' + target.toLowerCase(), label, page: 'gamemgr', event: 'click' });
  }
  for (const [form, label] of [
    ['setup', 'Start live play with this setup'],
    ['add-player', 'Save player details'],
    ['replace-player', 'Replace the court player'],
    ['choose-players', 'Save the match lineup'],
    ['correct-winner', 'Save the corrected match winner'],
  ]) control('[data-pm-form="' + form + '"]', 'play_submit_' + form.replace(/-/g, '_'), label, 'gamemgr', 'submit');
  control('#pm2OpenLiveView', 'play_player_view_open', 'Open the player live view', 'gamemgr', 'click');
  fields([
    ['pm2SessionSelect', 'Choose a play session to open'],
    ['pm2Date', 'Choose a play session date'],
    ['pm2Time', 'Edit the play session time draft'],
    ['pm2Names', 'Edit the player list draft'],
    ['pm2WalkInName', 'Edit the player name draft'],
    ['pm2ReplacementPlayer', 'Choose a replacement player'],
    ['pm2ReplacementName', 'Edit the replacement player name draft'],
  ], 'gamemgr');
  for (const [selector, action, label] of [
    ['[data-pm-form="setup"] input[name="courtIds"]', 'play_courts_edit', 'Choose the courts in play'],
    ['[data-pm-form="setup"] input[name="mode"]', 'play_rotation_edit', 'Choose the player rotation style'],
    ['[data-pm-form="setup"] input[name="rankingMode"]', 'play_ranking_edit', 'Choose how play standings are ranked'],
    ['#pm2AddDialog input[name="skillLevel"]', 'play_player_skill_edit', 'Choose the player skill level'],
    ['[data-pm-lineup-slot]', 'play_lineup_edit', 'Choose a player for the match lineup'],
    ['#pm2ReplaceDialog input[name="replacementSource"]', 'play_replacement_source_edit', 'Choose a waiting player or a new walk-in'],
    ['#pm2ReplaceDialog input[name="outgoingAction"]', 'play_outgoing_player_edit', 'Choose what happens to the replaced player'],
  ]) control(selector, action, label, 'gamemgr');

  const operations = {
    saveCourt: 'Save court details and pricing',
    deleteCourt: 'Delete court',
    setAllCourtsPromo: 'Apply promo settings to all courts',
    saveSetting: 'Save a venue setting',
    saveBookingFeePolicy: 'Save booking fee settings',
    addBlockedDate: 'Block a booking date',
    removeBlockedDate: 'Unblock a booking date',
    createOpenPlayGameSession: 'Create a play session',
    updateOpenPlayGameSession: 'Update a play session',
    replaceOpenPlayGamePlayers: 'Save the player list',
    addOpenPlayGamePlayer: 'Add a player to the play session',
    updateOpenPlayGamePlayer: 'Update play session player details',
    addOpenPlayGameRound: 'Create a play round',
    updateOpenPlayGameRound: 'Update play round assignments or results',
    updateOpenPlayGameRoundIfCurrent: 'Save current play assignments or results',
    replaceOpenPlayGameCourtPlayer: 'Replace a court player',
    correctOpenPlayGameMatchWinner: 'Correct a match winner',
    deleteLatestOpenPlayGameRound: 'Remove the latest play round',
    clearOpenPlayGameRounds: 'Clear the play session rounds',
    setOpenPlayGamePublicShare: 'Change live play sharing',
    rotateOpenPlayGamePublicShare: 'Generate a new live play link',
    syncOpenPlayGameQueueWaitTimes: 'Update player waiting times',
  };

  return { handlers, controls, operations };
});
