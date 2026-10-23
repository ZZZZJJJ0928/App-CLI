// QQ-specific parts of the network-native send: scope, recovery page, the
// maintained template version and the explicit rejection-code list. The page
// side of the template lives in userscripts/lib/qq-sendmail-v1.mjs.
import {QQ_SENDMAIL_TEMPLATE} from '../userscripts/lib/qq-sendmail-v1.mjs';

// Only these codes mean "not sent" (QQ keeps the composed message for them and,
// for login codes, refreshes the session before sending again). Any other
// nonzero code stays pending confirmation. -20011 also signals template drift.
const REJECTIONS = Object.freeze({
  login: [-5012, -20002, -20062, -20071, -21021],
  parameter: [-20011, -21101, -5151, -21501, -21132],
  temporary: [-21519, -20003],
});

export const QQ_NATIVE_SEND = Object.freeze({
  provider: 'qq_mail',
  template_version: QQ_SENDMAIL_TEMPLATE,
  page_url: 'https://wx.mail.qq.com/',
  // v1: new compose, one recipient, no cc, no attachments.
  inScope: request => request.mode === 'compose' && request.message.to.length === 1 && !request.message.cc.length &&
    !request.message.attachments?.length,
  rejections: Object.freeze(new Map(Object.entries(REJECTIONS).flatMap(([category, codes]) => codes.map(code => [code, category])))),
  driftCodes: Object.freeze([-20011]),
});
