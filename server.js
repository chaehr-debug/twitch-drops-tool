const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { chromium } = require('playwright');
const chzzk = require('./chzzk');
const cime = require('./cime');

const PROFILE_DIR = path.join(__dirname, 'automation-profile');
const PORT = process.env.PORT || 5175;

let state = { status: 'idle', log: [], results: [], platform: null };
let context = null;
let page = null;
let loginPollTimer = null;

function pushLog(msg) {
  state.log.push(`[${new Date().toISOString()}] ${msg}`);
  if (state.log.length > 800) state.log.shift();
}

// 연동/실행 도중 멈춰서(예: 브라우저 실행이 응답 없음) 새로 시작할 수 없을 때
// 사용자가 직접 눌러서 상태를 강제로 idle로 되돌리는 비상 초기화.
async function resetState() {
  const previousLog = state.log || [];
  previousLog.push(`[${new Date().toISOString()}] 사용자가 수동으로 초기화했습니다.`);
  clearTimeout(loginPollTimer);
  try {
    if (context) await context.close();
  } catch (_) {}
  context = null;
  page = null;
  state = { status: 'idle', log: previousLog, results: [], platform: null };
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
      throw new Error(`지원하지 않는 시간(60분 미만): ${minutes}분 (가능: 15, 20, 30, 45)`);
    }
    return subHourMap[minutes];
  }
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (rem !== 0 && rem !== 30) {
    throw new Error(`지원하지 않는 시간: ${minutes}분 (정시 또는 30분 단위여야 합니다)`);
  }
  return rem === 30 ? `${hours}시간 30분` : `${hours}시간`;
}

async function createTwitchCampaign(config, row) {
  const orgId = config.orgId;
  await page.goto(`https://dev.twitch.tv/org/${orgId}/console/drops-v3/campaign/create`, { waitUntil: 'networkidle' });

  await page.getByPlaceholder('캠페인 이름 입력').fill(row.campaignName);

  const start = new Date(row.startUTC);
  const end = new Date(row.endUTC);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error(`잘못된 날짜: startUTC="${row.startUTC}" endUTC="${row.endUTC}"`);
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
  if (!campaignId) throw new Error('캠페인 ID를 확인할 수 없습니다: ' + page.url());
  return campaignId;
}

async function addTwitchRewardTiers(config, campaignId) {
  await page.goto(`https://dev.twitch.tv/org/${config.orgId}/console/drops-v3/campaign/${campaignId}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: '드롭스' }).click();
  await page.waitForTimeout(500);

  for (const tier of config.rewardTiers) {
    const durationLabel = minutesToDurationLabel(tier.minutes);

    await page.getByRole('button', { name: '새로운 드롭 만들기' }).click();
    await page.waitForTimeout(500);

    await page.getByPlaceholder('드롭 이름 입력').fill(tier.name);

    await page.locator('button', { hasText: /시간|분/ }).last().click();
    await page.waitForTimeout(300);
    await page.getByText(durationLabel, { exact: true }).last().click();
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: '드롭 만들기' }).click();
    await page.waitForTimeout(1000);

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

async function setTwitchFinalStatus(config, campaignId) {
  const statusMap = {
    INACTIVE: 'CAMPAIGN_STATUS_INACTIVE',
    TEST: 'CAMPAIGN_STATUS_TEST',
    ACTIVE: 'CAMPAIGN_STATUS_ACTIVE',
  };
  const target = statusMap[config.finalStatus];
  if (!target) throw new Error(`알 수 없는 finalStatus: ${config.finalStatus}`);
  if (target === 'CAMPAIGN_STATUS_INACTIVE') return;

  await page.goto(`https://dev.twitch.tv/org/${config.orgId}/console/drops-v3/campaign/${campaignId}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '상태 변경' }).click();
  await page.waitForTimeout(500);
  await page.locator('select:has(option[value^="CAMPAIGN_STATUS_"])').selectOption(target);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '상태 변경' }).last().click();
  await page.waitForTimeout(1000);
}

async function linkAccount(platform) {
  if (state.status !== 'idle' && state.status !== 'error' && state.status !== 'done') {
    throw new Error(`이미 연동 중이거나 진행 중입니다 (status=${state.status})`);
  }
  state = { status: 'launching', log: [], results: [], platform };

  if (!context) {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: null,
      args: ['--remote-debugging-port=9333'], // 디버깅용 임시 포트, 문제 해결 후 제거 예정
    });
    // 사용자가 창을 직접 닫거나 브라우저가 죽으면 즉시 참조를 비워서,
    // 다음 "연동 시작"이 죽은 context를 붙들고 멈추지 않고 새로 띄우도록 한다.
    context.on('close', () => {
      context = null;
      page = null;
    });
  }
  page = context.pages()[0] || (await context.newPage());

  // 원인을 알 수 없는 네이티브 파일 선택 창이 자동화 도중 뜨는 문제에 대한 안전장치.
  // 실수로 파일 선택 창이 열리면 자동으로 취소해서 자동화가 멈추지 않게 한다.
  page.removeAllListeners('filechooser');
  page.on('filechooser', async (fileChooser) => {
    try {
      await fileChooser.setFiles([]);
      pushLog('예상치 못한 파일 선택 창을 자동으로 닫았습니다.');
    } catch (_) {}
  });

  // alert()/confirm() 같은 네이티브 팝업이 뜨면 Playwright는 자동으로 닫지 않고
  // 페이지 JS 실행 자체를 막아버려서, 로그도 안 올라오고 그대로 멈춘 것처럼 보인다.
  // 항상 "확인"을 눌러서 자동화가 멈추지 않게 한다.
  page.removeAllListeners('dialog');
  page.on('dialog', async (dialog) => {
    try {
      pushLog(`예상치 못한 팝업(${dialog.type()}): "${dialog.message()}" 을(를) 자동으로 확인 처리했습니다.`);
      await dialog.accept();
    } catch (_) {}
  });

  if (platform === 'chzzk') {
    await page.goto(chzzk.LOGIN_URL, { waitUntil: 'networkidle' });
  } else if (platform === 'cime') {
    await page.goto(cime.LOGIN_URL, { waitUntil: 'networkidle' });
  } else {
    await page.goto('https://dev.twitch.tv/console', { waitUntil: 'networkidle' });
  }

  state.status = 'awaiting_login';
  pushLog('브라우저 창에서 로그인을 진행해주세요. (이미 로그인되어 있다면 자동으로 넘어갑니다)');
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(loginPollTimer);
  loginPollTimer = setTimeout(pollLogin, 1500);
}

async function pollLogin() {
  if (state.status !== 'awaiting_login') return;
  try {
    let loggedIn;
    if (state.platform === 'chzzk') {
      loggedIn = await chzzk.isFullyConnected(page);
    } else if (state.platform === 'cime') {
      loggedIn = await cime.isFullyConnected(page);
    } else {
      loggedIn = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === '로그아웃')
      );
    }
    if (loggedIn) {
      state.status = 'connected';
      pushLog('로그인 확인됨. 연동이 완료되었습니다.');
      return;
    }
  } catch (err) {
    pushLog(`로그인 확인 중 오류(재시도): ${err.message}`);
  }
  schedulePoll();
}

async function runSchedule(config, schedule) {
  if (state.status !== 'connected') {
    throw new Error(`먼저 계정 연동을 완료해주세요 (status=${state.status})`);
  }
  const platform = state.platform;
  state.status = 'running';
  pushLog('캠페인 생성을 시작합니다.');

  for (let i = 0; i < schedule.length; i++) {
    const row = schedule[i];

    if (platform === 'chzzk') {
      pushLog(`[${i + 1}/${schedule.length}] 생성 중: ${row.campaignTitle} (${row.startKST} ~ ${row.endKST})`);
      try {
        const campaignId = await chzzk.createCampaign(page, config, row);
        pushLog(`  캠페인 생성됨${campaignId ? ` (번호: ${campaignId})` : ''}`);
        state.results.push({
          campaignName: row.campaignTitle,
          startUTC: row.startKST,
          endUTC: row.endKST,
          campaignId: campaignId || '',
          url: '',
          status: 'OK',
          error: '',
        });
      } catch (err) {
        pushLog(`  오류: ${err.message}`);
        state.results.push({
          campaignName: row.campaignTitle,
          startUTC: row.startKST,
          endUTC: row.endKST,
          campaignId: '',
          url: '',
          status: 'ERROR',
          error: err.message,
        });
      }
      continue;
    }

    if (platform === 'cime') {
      pushLog(`[${i + 1}/${schedule.length}] 생성 중: ${row.campaignTitle} (${row.startKST} ~ ${row.endKST})`);
      try {
        await cime.createCampaign(page, config, row);
        pushLog(`  캠페인 생성됨`);
        state.results.push({
          campaignName: row.campaignTitle,
          startUTC: row.startKST,
          endUTC: row.endKST,
          campaignId: '',
          url: '',
          status: 'OK',
          error: '',
        });
      } catch (err) {
        pushLog(`  오류: ${err.message}`);
        state.results.push({
          campaignName: row.campaignTitle,
          startUTC: row.startKST,
          endUTC: row.endKST,
          campaignId: '',
          url: '',
          status: 'ERROR',
          error: err.message,
        });
      }
      continue;
    }

    pushLog(`[${i + 1}/${schedule.length}] 생성 중: ${row.campaignName} (${row.startUTC} ~ ${row.endUTC})`);
    try {
      const campaignId = await createTwitchCampaign(config, row);
      pushLog(`  캠페인 생성됨: ${campaignId}`);
      await addTwitchRewardTiers(config, campaignId);
      await setTwitchFinalStatus(config, campaignId);
      const url = `https://dev.twitch.tv/org/${config.orgId}/console/drops-v3/campaign/${campaignId}`;
      pushLog(`  완료. 상태: ${config.finalStatus}`);
      state.results.push({ campaignName: row.campaignName, startUTC: row.startUTC, endUTC: row.endUTC, campaignId, url, status: 'OK', error: '' });
    } catch (err) {
      pushLog(`  오류: ${err.message}`);
      state.results.push({ campaignName: row.campaignName, startUTC: row.startUTC, endUTC: row.endUTC, campaignId: '', url: '', status: 'ERROR', error: err.message });
    }
  }

  state.status = 'done';
  pushLog('모든 작업이 완료되었습니다.');
}

function validateConfig(platform, config) {
  if (!config || typeof config !== 'object') throw new Error('config가 필요합니다.');

  if (platform === 'chzzk') {
    const required = ['description', 'categoryLabel', 'clientId', 'pcLinkUrl', 'mobileLinkUrl'];
    for (const key of required) {
      if (!config[key]) throw new Error(`config.${key} 값이 필요합니다.`);
    }
    if (!Array.isArray(config.rewardTiers) || config.rewardTiers.length === 0 || config.rewardTiers.length > 6) {
      throw new Error('config.rewardTiers는 1~6개여야 합니다.');
    }
    for (const tier of config.rewardTiers) {
      if (!tier.name || !tier.usageGuideTemplate || !tier.rewardIdTemplate) {
        throw new Error('각 rewardTier는 name, usageGuideTemplate, rewardIdTemplate이 필요합니다.');
      }
      if (tier.watchHour === undefined || tier.watchMinute === undefined) {
        throw new Error('각 rewardTier는 watchHour, watchMinute이 필요합니다.');
      }
    }
    return;
  }

  if (platform === 'cime') {
    if (!config.description) throw new Error('config.description 값이 필요합니다.');
    if (!Array.isArray(config.rewardTiers) || config.rewardTiers.length === 0) {
      throw new Error('config.rewardTiers는 최소 1개 이상이어야 합니다.');
    }
    for (const tier of config.rewardTiers) {
      if (!tier.name || !tier.description || !tier.minWatchMinutes) {
        throw new Error('각 rewardTier는 name, description, minWatchMinutes가 필요합니다.');
      }
    }
    return;
  }

  const required = ['orgId', 'game', 'redemptionURL', 'detailsURL', 'description', 'finalStatus'];
  for (const key of required) {
    if (!config[key]) throw new Error(`config.${key} 값이 필요합니다.`);
  }
  if (!['TEST', 'ACTIVE', 'INACTIVE'].includes(config.finalStatus)) {
    throw new Error('config.finalStatus는 TEST, ACTIVE, INACTIVE 중 하나여야 합니다.');
  }
  if (!Array.isArray(config.rewardTiers) || config.rewardTiers.length === 0) {
    throw new Error('config.rewardTiers는 최소 1개 이상이어야 합니다.');
  }
  for (const tier of config.rewardTiers) {
    if (!tier.minutes || !tier.name || !Array.isArray(tier.rewardIds) || tier.rewardIds.length === 0) {
      throw new Error('각 rewardTier는 minutes, name, rewardIds(1개 이상)가 필요합니다.');
    }
  }
}

function validateSchedule(platform, schedule) {
  if (!Array.isArray(schedule) || schedule.length === 0) {
    throw new Error('schedule에는 최소 1개 이상의 행이 필요합니다.');
  }

  if (platform === 'chzzk') {
    for (const row of schedule) {
      if (!row.campaignTitle || !row.campaignId || !row.startKST || !row.endKST) {
        throw new Error('각 행은 campaignTitle, campaignId, startKST, endKST가 필요합니다.');
      }
    }
    return;
  }

  if (platform === 'cime') {
    for (const row of schedule) {
      if (!row.campaignTitle || !row.startKST || !row.endKST) {
        throw new Error('각 행은 campaignTitle, startKST, endKST가 필요합니다.');
      }
    }
    return;
  }

  for (const row of schedule) {
    if (!row.campaignName || !row.startUTC || !row.endUTC) {
      throw new Error('각 행은 campaignName, startUTC, endUTC가 필요합니다.');
    }
  }
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/connect' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const platform = body.platform || 'twitch';
      await linkAccount(platform);
      return json(res, { ok: true });
    }

    if (url.pathname === '/api/run' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const platform = body.platform || state.platform || 'twitch';
      if (state.platform && state.platform !== platform) {
        throw new Error(
          `현재 연동된 플랫폼(${state.platform})과 요청한 플랫폼(${platform})이 다릅니다. 페이지를 새로고침한 뒤 다시 연동해주세요.`
        );
      }
      validateConfig(platform, body.config);
      validateSchedule(platform, body.schedule);
      runSchedule(body.config, body.schedule).catch((err) => {
        pushLog(`치명적 오류: ${err.message}`);
        state.status = 'error';
      });
      return json(res, { ok: true });
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      return json(res, state);
    }

    if (url.pathname === '/api/reset' && req.method === 'POST') {
      await resetState();
      return json(res, { ok: true });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    json(res, { error: err.message }, 400);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Twitch Drops 툴 서버 실행 중: ${url}`);
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
  }
});
