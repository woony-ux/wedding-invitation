const SPREADSHEET_TITLE = '청첩장 운영 데이터';
const APPLICATION_SHEET_NAME = '신청자';
const TICKET_SHEET_NAME = '추첨권';
const EDITOR_EMAILS = [
  'kham0126@gmail.com',
  'google-sheets@covering-app-ccd23.iam.gserviceaccount.com'
];
const SPREADSHEET_ID_PROPERTY = 'WEDDING_OPERATION_SPREADSHEET_ID';
const LEGACY_SPREADSHEET_ID_PROPERTY = 'SOLO_APPLICATION_SPREADSHEET_ID';
const TICKET_COUNTER_PROPERTY = 'LUCKY_TICKET_NEXT_NUMBER';
const WEDDING_TIMEZONE = 'Asia/Seoul';
const LUCKY_TICKET_OPEN_ISO = '2026-08-09T00:00:00+09:00';
const LUCKY_TICKET_CLOSE_ISO = '2026-08-10T00:00:00+09:00';
const MAX_TICKET_NUMBER = 9999;

const APPLICATION_HEADERS = [
  'received_at',
  'application_id',
  'name',
  'age',
  'gender',
  'side',
  'job',
  'mbti',
  'intro',
  'contact',
  'alias',
  'source',
  'user_agent'
];

const LEGACY_APPLICATION_HEADERS = [
  'received_at',
  'name',
  'age',
  'gender',
  'side',
  'job',
  'mbti',
  'intro',
  'contact',
  'alias',
  'source',
  'user_agent'
];

const TICKET_HEADERS = [
  'issued_at',
  'ticket_id',
  'ticket_number',
  'device_hash',
  'source',
  'user_agent'
];

function doGet() {
  return json_({
    ok: true,
    service: 'wedding-invitation',
    features: {
      soloApplication: true,
      luckyTicket: true
    },
    luckyTicketWindow: {
      openAt: LUCKY_TICKET_OPEN_ISO,
      closeAt: LUCKY_TICKET_CLOSE_ISO,
      timezone: WEDDING_TIMEZONE
    }
  });
}

function doPost(event) {
  try {
    const payload = parsePayload_(event);
    const action = sanitizeCell_(payload.action || inferAction_(payload), 40);

    if (action === 'submit_solo_application') {
      return json_(submitSoloApplication_(payload));
    }

    if (action === 'issue_lucky_ticket') {
      return json_(issueLuckyTicket_(payload));
    }

    throw new Error('unsupported_action');
  } catch (error) {
    console.error(error);
    return json_({
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
  }
}

function setupSpreadsheet() {
  const spreadsheet = getOrCreateSpreadsheet_();
  getOrCreateApplicationSheet_(spreadsheet);
  getOrCreateTicketSheet_(spreadsheet);
  shareSpreadsheet_(spreadsheet);
  return {
    spreadsheetId: spreadsheet.getId(),
    spreadsheetUrl: spreadsheet.getUrl()
  };
}

function submitSoloApplication_(payload) {
  const application = validateApplication_(payload);
  const lock = LockService.getScriptLock();
  lock.waitLock(8000);

  try {
    const spreadsheet = getOrCreateSpreadsheet_();
    const sheet = getOrCreateApplicationSheet_(spreadsheet);
    const existingRow = findRowByValue_(sheet, 2, application.applicationId);

    if (existingRow) {
      return {
        ok: true,
        duplicate: true,
        applicationId: application.applicationId
      };
    }

    sheet.appendRow([
      new Date(),
      application.applicationId,
      application.name,
      application.age,
      application.gender,
      application.side,
      application.job,
      application.mbti,
      application.intro,
      application.contact,
      application.alias,
      application.source,
      application.userAgent
    ]);

    return {
      ok: true,
      duplicate: false,
      applicationId: application.applicationId
    };
  } finally {
    lock.releaseLock();
  }
}

function issueLuckyTicket_(payload) {
  if (!isLuckyTicketOpen_(new Date())) {
    return {
      ok: false,
      error: 'ticket_not_open',
      openAt: LUCKY_TICKET_OPEN_ISO,
      closeAt: LUCKY_TICKET_CLOSE_ISO
    };
  }

  const deviceId = sanitizeCell_(payload.deviceId, 160);
  if (!deviceId) {
    throw new Error('missing_device_id');
  }

  const deviceHash = sha256_(deviceId);
  const userAgent = sanitizeCell_(payload.userAgent, 240);
  const source = sanitizeCell_(payload.source || 'wedding-invitation', 40);
  const lock = LockService.getScriptLock();
  lock.waitLock(8000);

  try {
    const spreadsheet = getOrCreateSpreadsheet_();
    const sheet = getOrCreateTicketSheet_(spreadsheet);
    const existingRow = findRowByValue_(sheet, 4, deviceHash);

    if (existingRow) {
      const number = sheet.getRange(existingRow, 3).getValue();
      const ticketId = sheet.getRange(existingRow, 2).getValue();
      return {
        ok: true,
        duplicate: true,
        number,
        ticketId
      };
    }

    const number = getNextTicketNumber_();
    const ticketId = Utilities.getUuid();
    sheet.appendRow([
      new Date(),
      ticketId,
      number,
      deviceHash,
      source,
      userAgent
    ]);

    return {
      ok: true,
      duplicate: false,
      number,
      ticketId,
      issuedAt: new Date().toISOString()
    };
  } finally {
    lock.releaseLock();
  }
}

function inferAction_(payload) {
  if (payload && (payload.name || payload.intro || payload.gender || payload.side)) {
    return 'submit_solo_application';
  }
  return '';
}

function getOrCreateSpreadsheet_() {
  const properties = PropertiesService.getScriptProperties();
  const existingId =
    properties.getProperty(SPREADSHEET_ID_PROPERTY) ||
    properties.getProperty(LEGACY_SPREADSHEET_ID_PROPERTY);

  if (existingId) {
    try {
      const spreadsheet = SpreadsheetApp.openById(existingId);
      properties.setProperty(SPREADSHEET_ID_PROPERTY, spreadsheet.getId());
      return spreadsheet;
    } catch (error) {
      properties.deleteProperty(SPREADSHEET_ID_PROPERTY);
      properties.deleteProperty(LEGACY_SPREADSHEET_ID_PROPERTY);
    }
  }

  const spreadsheet = SpreadsheetApp.create(SPREADSHEET_TITLE);
  properties.setProperty(SPREADSHEET_ID_PROPERTY, spreadsheet.getId());
  shareSpreadsheet_(spreadsheet);
  return spreadsheet;
}

function getOrCreateApplicationSheet_(spreadsheet) {
  const sheet = getOrCreateSheetByName_(spreadsheet, APPLICATION_SHEET_NAME);
  migrateLegacyApplicationHeaders_(sheet);
  ensureHeaders_(sheet, APPLICATION_HEADERS);
  return sheet;
}

function getOrCreateTicketSheet_(spreadsheet) {
  const sheet = getOrCreateSheetByName_(spreadsheet, TICKET_SHEET_NAME);
  ensureHeaders_(sheet, TICKET_HEADERS);
  return sheet;
}

function getOrCreateSheetByName_(spreadsheet, sheetName) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  return sheet;
}

function migrateLegacyApplicationHeaders_(sheet) {
  if (sheet.getLastRow() === 0) return;

  const firstRow = sheet.getRange(1, 1, 1, LEGACY_APPLICATION_HEADERS.length).getValues()[0];
  const isLegacy = LEGACY_APPLICATION_HEADERS.every((header, index) => firstRow[index] === header);
  if (!isLegacy) return;

  sheet.insertColumnAfter(1);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const ids = [];
    for (let index = 2; index <= lastRow; index += 1) {
      ids.push([`legacy-${Utilities.getUuid()}`]);
    }
    sheet.getRange(2, 2, ids.length, 1).setValues(ids);
  }
}

function ensureHeaders_(sheet, headers) {
  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const needsHeaders = headers.some((header, index) => firstRow[index] !== header);
  if (!needsHeaders) return;

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
}

function findRowByValue_(sheet, column, value) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const values = sheet.getRange(2, column, lastRow - 1, 1).getValues();
  for (let index = 0; index < values.length; index += 1) {
    if (String(values[index][0]) === String(value)) {
      return index + 2;
    }
  }
  return null;
}

function getNextTicketNumber_() {
  const properties = PropertiesService.getScriptProperties();
  const nextNumber = Number(properties.getProperty(TICKET_COUNTER_PROPERTY) || '1');
  if (!Number.isInteger(nextNumber) || nextNumber < 1 || nextNumber > MAX_TICKET_NUMBER) {
    throw new Error('ticket_sold_out');
  }

  properties.setProperty(TICKET_COUNTER_PROPERTY, String(nextNumber + 1));
  return `WJ-${String(nextNumber).padStart(4, '0')}`;
}

function shareSpreadsheet_(spreadsheet) {
  const file = DriveApp.getFileById(spreadsheet.getId());
  EDITOR_EMAILS.forEach(email => {
    try {
      file.addEditor(email);
    } catch (error) {
      console.warn('Failed to share spreadsheet with ' + email + ': ' + error);
    }
  });
}

function parsePayload_(event) {
  const body = event && event.postData && event.postData.contents
    ? event.postData.contents
    : '';

  if (body) {
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error('invalid_payload');
    }
  }

  if (event && event.parameter && event.parameter.payload) {
    try {
      return JSON.parse(event.parameter.payload);
    } catch (error) {
      throw new Error('invalid_payload');
    }
  }

  return {};
}

function validateApplication_(payload) {
  const applicationId = sanitizeCell_(payload.id || payload.applicationId || Utilities.getUuid(), 80);
  const name = sanitizeCell_(payload.name, 20);
  const age = Number(payload.age);
  const gender = sanitizeCell_(payload.gender, 10);
  const side = sanitizeCell_(payload.side, 10);
  const job = sanitizeCell_(payload.job, 30);
  const mbti = sanitizeCell_(String(payload.mbti || '').toUpperCase(), 4);
  const intro = sanitizeCell_(payload.intro, 160);
  const contact = sanitizeCell_(payload.contact, 40);
  const alias = sanitizeCell_(payload.alias, 20);
  const source = sanitizeCell_(payload.source || 'wedding-invitation', 40);
  const userAgent = sanitizeCell_(payload.userAgent, 240);

  if (!applicationId || !name || !Number.isInteger(age) || age < 20 || age > 55 || !job || !intro) {
    throw new Error('missing_required_fields');
  }
  if (gender !== '남성' && gender !== '여성') {
    throw new Error('invalid_gender');
  }
  if (side !== '신랑측' && side !== '신부측') {
    throw new Error('invalid_side');
  }
  if (mbti && !/^[A-Z]{4}$/.test(mbti)) {
    throw new Error('invalid_mbti');
  }

  return {
    applicationId,
    name,
    age,
    gender,
    side,
    job,
    mbti,
    intro,
    contact,
    alias,
    source,
    userAgent
  };
}

function isLuckyTicketOpen_(now) {
  return now >= new Date(LUCKY_TICKET_OPEN_ISO) && now < new Date(LUCKY_TICKET_CLOSE_ISO);
}

function sha256_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );
  return bytes.map(byte => {
    const unsigned = byte < 0 ? byte + 256 : byte;
    return unsigned.toString(16).padStart(2, '0');
  }).join('');
}

function sanitizeCell_(value, maxLength) {
  let text = String(value || '').trim().slice(0, maxLength);
  if (/^[=+\-@]/.test(text)) {
    text = "'" + text;
  }
  return text;
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
