const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PROFILE_DIR = path.join(__dirname, 'automation-profile');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const SCHEDULE_PATH = path.join(__dirname, 'schedule.csv');
const RESULTS_PATH = path.join(__dirname, 'results.csv');

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const fields = splitCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h.trim()] = (fields[i] || '').trim(); });
    return row;
  });
}

function splitCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { result.push(cur); cur = ''; }
      else cur += c;
    }
  }
  result.push(cur);
  return result;
}

function csvEscape(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function formatDateUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}.${m}.${day}.`;
}

function formatTimeUTC(d) {
  let h = d.getUTCHours();
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = h < 12 ? 'am' : 'pm';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min}${ampm}`;
}

function minutesToDurationLabel(minutes) {
  const subHourMap = { 15: '15분', 20: '20분', 30: '30분', 45: '45분' };
  if (minutes < 60) {
    if (!subHourMap[minutes]) {
      throw new Error(`Unsupported sub-hour duration: ${minutes} minutes (valid: 15, 20, 30, 45)`);
    }
    return subHourMap[minutes];
  }
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (rem !== 0 && rem !== 30) {
    throw new Error(`Unsupported duration: ${minutes} minutes (must be a whole or half hour)`);
  }
  return rem === 30 ? `${hours}시간 30분` : `${hours}시간`;
}

async function createCampaign(page, config, row) {
  const orgId = config.orgId;
  await page.goto(`https://dev.twitch.tv/org/${orgId}/console/drops-v3/campaign/create`, { waitUntil: 'networkidle' });

  await page.getByPlaceholder('캠페인 이름 입력').fill(row.campaignName);

  const start = new Date(row.startUTC);
  const end = new Date(row.endUTC);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error(`Invalid date(s): startUTC="${row.startUTC}" endUTC="${row.endUTC}"`);
  }

  const dateInputs = page.locator('#event-start-date');
  const timeInputs = page.locator('#event-start-time');

  await dateInputs.nth(0).fill(formatDateUTC(start));
  await page.keyboard.press('Escape');
  await timeInputs.nth(0).fill(formatTimeUTC(start));
  await page.keyboard.press('Escape');

  await dateInputs.nth(1).fill(formatDateUTC(end));
  await page.keyboard.press('Escape');
  await timeInputs.nth(1).fill(formatTimeUTC(end));
  await page.keyboard.press('Escape');

  await page.locator('select[name="game_search"]').selectOption({ label: config.game });

  const urlInputs = page.getByPlaceholder('URL 입력');
  await urlInputs.nth(0).fill(config.redemptionURL);
  await urlInputs.nth(1).fill(config.detailsURL);

  await page.getByPlaceholder('설명 입력').fill(config.description);

  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  await page.getByRole('button', { name: '드롭 캠페인 만들기' }).click();
  await page.waitForURL(new RegExp(`/campaign/${UUID_RE.source}`, 'i'), { timeout: 15000 });
  await page.waitForLoadState('networkidle');

  const match = page.url().match(new RegExp(`/campaign/(${UUID_RE.source})`, 'i'));
  const campaignId = match ? match[1] : null;
  if (!campaignId) throw new Error('Could not determine campaign ID after creation: ' + page.url());
  return campaignId;
}

async function uploadImageIfConfigured(page, config, orgId, campaignId) {
  if (!config.imagePath) return;
  await page.goto(`https://dev.twitch.tv/org/${orgId}/console/drops-v3/campaign/${campaignId}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: '캠페인 세부 정보' }).click();
  await page.setInputFiles('input[type="file"]', config.imagePath);
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: '변경 내용 저장' }).click();
  await page.waitForTimeout(1000);
}

async function addRewardTiers(page, config, orgId, campaignId) {
  await page.goto(`https://dev.twitch.tv/org/${orgId}/console/drops-v3/campaign/${campaignId}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: '드롭스' }).click();
  await page.waitForTimeout(500);

  for (const tier of config.rewardTiers) {
    const durationLabel = minutesToDurationLabel(tier.minutes);

    await page.getByRole('button', { name: '새로운 드롭 만들기' }).click();
    await page.waitForTimeout(500);

    await page.getByPlaceholder('드롭 이름 입력').fill(tier.name);

    // open duration dropdown (button currently shows the default/current value)
    await page.locator('button', { hasText: /시간|분/ }).last().click();
    await page.waitForTimeout(300);
    await page.getByText(durationLabel, { exact: true }).last().click();
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: '드롭 만들기' }).click();
    await page.waitForTimeout(1000);

    // locate the row for this tier by its rendered "{minutes}분" label and open the add-reward (+) icon
    const row = page.locator('[data-test-selector="dev-drop-row-bar-selector"]', { hasText: `${tier.minutes}분` }).last();
    await row.locator('.dev-drop-reward-bar__plus-reward-icon button').click();
    await page.waitForTimeout(500);

    const searchBox = page.getByPlaceholder(/보상 이름이나 보상 ID로/);
    for (const rewardId of tier.rewardIds) {
      await searchBox.fill(rewardId);
      await page.waitForTimeout(500);
      await page.locator(`label[for="${rewardId}"]`).click();
      await searchBox.fill('');
      await page.waitForTimeout(300);
    }

    await page.getByRole('button', { name: /저장/ }).click();
    await page.waitForTimeout(1000);
  }
}

async function setFinalStatus(page, config, orgId, campaignId) {
  const statusMap = {
    INACTIVE: 'CAMPAIGN_STATUS_INACTIVE',
    TEST: 'CAMPAIGN_STATUS_TEST',
    ACTIVE: 'CAMPAIGN_STATUS_ACTIVE',
  };
  const target = statusMap[config.finalStatus];
  if (!target) throw new Error(`Unknown finalStatus in config: ${config.finalStatus}`);
  if (target === 'CAMPAIGN_STATUS_INACTIVE') return; // already the default state, nothing to do

  await page.goto(`https://dev.twitch.tv/org/${orgId}/console/drops-v3/campaign/${campaignId}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '상태 변경' }).click();
  await page.waitForTimeout(500);
  await page.locator('select:has(option[value^="CAMPAIGN_STATUS_"])').selectOption(target);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '상태 변경' }).last().click();
  await page.waitForTimeout(1000);
}

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const rows = parseCsv(fs.readFileSync(SCHEDULE_PATH, 'utf8'));

  if (rows.length === 0) {
    console.log('schedule.csv has no rows. Nothing to do.');
    return;
  }

  console.log(`Loaded ${rows.length} row(s) from schedule.csv`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
  });
  const page = context.pages()[0] || await context.newPage();

  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    console.log(`\n[${i + 1}/${rows.length}] Creating: ${row.campaignName} (${row.startUTC} ~ ${row.endUTC})`);
    try {
      const campaignId = await createCampaign(page, config, row);
      console.log(`  Campaign created: ${campaignId}`);

      await uploadImageIfConfigured(page, config, config.orgId, campaignId);
      await addRewardTiers(page, config, config.orgId, campaignId);
      await setFinalStatus(page, config, config.orgId, campaignId);

      const url = `https://dev.twitch.tv/org/${config.orgId}/console/drops-v3/campaign/${campaignId}`;
      console.log(`  Done. Status set to ${config.finalStatus}. URL: ${url}`);
      results.push({ campaignName: row.campaignName, startUTC: row.startUTC, endUTC: row.endUTC, campaignId, url, status: 'OK', error: '' });
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      const screenshotPath = path.join(__dirname, `error-row-${i + 1}.png`);
      try { await page.screenshot({ path: screenshotPath, fullPage: true }); } catch (_) {}
      results.push({ campaignName: row.campaignName, startUTC: row.startUTC, endUTC: row.endUTC, campaignId: '', url: '', status: 'ERROR', error: err.message });
    }
  }

  const csvLines = ['campaignName,startUTC,endUTC,campaignId,url,status,error'];
  for (const r of results) {
    csvLines.push([r.campaignName, r.startUTC, r.endUTC, r.campaignId, r.url, r.status, r.error].map(csvEscape).join(','));
  }
  fs.writeFileSync(RESULTS_PATH, csvLines.join('\n'), 'utf8');
  console.log(`\nResults written to ${RESULTS_PATH}`);

  await context.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
