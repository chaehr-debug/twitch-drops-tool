const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'https://friend.navercorp.com/login/loginForm.sec';

function parseKST(str) {
  // "YYYY-MM-DD HH:mm"
  const m = String(str).trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`잘못된 날짜 형식입니다 (YYYY-MM-DD HH:mm 형식이어야 함): "${str}"`);
  const [, y, mo, d, h, mi] = m;
  return {
    dateTitle: `${y}-${mo}-${d}`,
    hour: String(Number(h)),
    minute: String(Number(mi)),
    y: Number(y), mo: Number(mo), d: Number(d), h: Number(h), mi: Number(mi),
  };
}

function addDays(parsed, days) {
  const d = new Date(Date.UTC(parsed.y, parsed.mo - 1, parsed.d));
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return { dateTitle: `${y}-${mo}-${day}`, mo: d.getUTCMonth() + 1, d: d.getUTCDate(), y };
}

function koreanDeadlineLabel(dateObj, time) {
  return `${dateObj.mo}월 ${dateObj.d}일 ${time}`;
}

function mmdd(parsed) {
  return `${String(parsed.mo).padStart(2, '0')}${String(parsed.d).padStart(2, '0')}`;
}

function findCouponFolder(baseFolder, mmddStr) {
  if (!baseFolder) return null;
  if (!fs.existsSync(baseFolder)) throw new Error(`쿠폰 상위 폴더를 찾을 수 없습니다: ${baseFolder}`);
  const entries = fs.readdirSync(baseFolder, { withFileTypes: true });
  const match = entries.find((e) => e.isDirectory() && e.name.includes(mmddStr));
  if (!match) throw new Error(`"${mmddStr}"가 포함된 하위 폴더를 찾을 수 없습니다 (${baseFolder} 안에서 검색)`);
  return path.join(baseFolder, match.name);
}

function findCouponFiles(folder, count) {
  const files = [];
  for (let i = 1; i <= count; i++) {
    const p = path.join(folder, `치지직_${i}.xlsx`);
    if (!fs.existsSync(p)) throw new Error(`쿠폰 파일을 찾을 수 없습니다: ${p}`);
    files.push(p);
  }
  return files;
}

function getDropsFrame(page) {
  return page.frames().find((f) => f.url().includes('nng-developer.admin.navercorp.com'));
}

async function isFullyConnected(page) {
  const url = page.url();
  if (url.includes('friend.navercorp.com/login')) return false;

  if (getDropsFrame(page)) return true;

  if (url.includes('friend.navercorp.com/main/welcome')) {
    try {
      await page.getByText('Naver Games', { exact: true }).click({ timeout: 2000 });
      await page.waitForTimeout(1500);
    } catch (_) {}
  }
  return !!getDropsFrame(page);
}

async function setAntDateTime(frame, page, inputLocator, dateTitle, hour, minute) {
  await inputLocator.click();
  await page.waitForTimeout(500);
  const cell = frame.locator(`.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) td[title="${dateTitle}"]`).last();
  await cell.click();
  await page.waitForTimeout(500);

  const cols = await frame.locator('.ant-picker-time-panel-column:visible').all();
  if (cols.length >= 2) {
    await cols[0].locator('li', { hasText: hour }).first().click();
    await page.waitForTimeout(300);
    await cols[1].locator('li', { hasText: minute }).first().click();
    await page.waitForTimeout(500);
    const okBtn = frame.locator('.ant-picker-ok button:visible');
    if ((await okBtn.count()) > 0 && !(await okBtn.first().isDisabled())) {
      await okBtn.first().click();
      await page.waitForTimeout(500);
    }
  }
}

async function setSingleDate(frame, dateTitle) {
  const cell = frame.locator(`.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) td[title="${dateTitle}"] .ant-picker-cell-inner`);
  await cell.click();
}

async function selectAntSelectExact(frame, page, inputLocator, exactText) {
  await inputLocator.click({ force: true });
  await page.waitForTimeout(400);
  const option = frame
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ hasText: new RegExp(`^${exactText}$`) })
    .first();
  await option.click();
  await page.waitForTimeout(300);
}

async function fillRewardItem(frame, page, tier, couponFilePath, validUntilDateTitle) {
  await frame.getByText('리워드 추가', { exact: true }).click();
  await page.waitForTimeout(800);

  // .ant-modal은 닫힌 뒤에도 DOM에 숨겨진 채 남아있는 경우가 있어, 반드시 현재
  // 화면에 보이는 모달 하나만 선택해야 한다 (안 그러면 리워드 개수만큼 "등록" 버튼이
  // 여러 개 잡히는 등 엉뚱한 요소를 건드리는 문제로 이어진다).
  const modal = frame.locator('.ant-modal:visible').last();

  await modal.locator('#title').fill(tier.name);

  if (tier.imagePath) {
    await modal.locator('input[type="file"]').first().setInputFiles(tier.imagePath);
    await page.waitForTimeout(800);
  }

  await modal.locator('#codeUseGuide').fill(tier.usageGuide);
  await modal.locator('#rewardId').fill(tier.rewardId);

  // validity deadline (single date, must be later than campaign end date)
  await modal.locator('#codeEndDate').click();
  await page.waitForTimeout(500);
  await setSingleDate(frame, validUntilDateTitle);
  await page.waitForTimeout(600);

  // coupon file upload — 엑셀 파싱에 시간이 걸리므로 넉넉히 기다린 뒤 업로드 버튼을 누르고,
  // 버튼이 다시 눌러도 되는(활성/표시) 상태가 아닐 때까지 대기해 업로드가 끝나기 전에
  // 다음 단계로 넘어가 모달이 꼬이는 것을 막는다.
  await modal.locator('input[type="file"]').nth(1).setInputFiles(couponFilePath);
  await page.waitForTimeout(800);
  await modal.getByText('업로드', { exact: true }).click();
  await page.waitForTimeout(2000);

  // watch time
  await selectAntSelectExact(frame, page, modal.locator('#requiredWatchTime_hour'), String(tier.watchHour));
  await selectAntSelectExact(frame, page, modal.locator('#requiredWatchTime_minute'), String(tier.watchMinute));

  await modal.getByRole('button', { name: '등록', exact: true }).click();
  await page.waitForTimeout(1200);
}

// 특정 스트리머만 드롭스에 참여하도록 제한한다. UID가 없으면 기본값인
// "전체 (권장)" 그대로 두고 아무것도 건드리지 않는다.
async function setTargetStreamers(frame, page, uids) {
  if (!uids || uids.length === 0) return;

  await frame.locator('.ant-select', { hasText: '전체 (권장)' }).click();
  await page.waitForTimeout(500);
  await frame.getByText('지정 스트리머', { exact: true }).click();
  await page.waitForTimeout(800);

  const row = frame.locator('.ant-form-item-row', { has: frame.locator('label[for="targetChannelList"]') });
  const typeSelect = row.locator('.ant-select').first();
  const input = row.locator('input[placeholder*="UID를 입력"]');

  for (const uid of uids) {
    // "등록"을 누르면 채널/UID 선택이 "채널"로 초기화되므로 매번 다시 UID로 전환해야 한다.
    await typeSelect.click();
    await page.waitForTimeout(400);
    await frame.getByText('UID', { exact: true }).click();
    await page.waitForTimeout(400);

    await input.fill(uid);
    await row.getByRole('button', { name: '등록', exact: true }).click();
    await page.waitForTimeout(800);
  }
}

async function createCampaign(page, config, row) {
  const start = parseKST(row.startKST);
  const end = parseKST(row.endKST);
  const validUntil = addDays(end, 1);
  const validUntilLabel = koreanDeadlineLabel(validUntil, config.rewardValidUntilTime || '23:59');
  const dayMmdd = mmdd(start);

  let couponFiles = [];
  if (config.couponBaseFolder) {
    const folder = findCouponFolder(config.couponBaseFolder, dayMmdd);
    couponFiles = findCouponFiles(folder, config.rewardTiers.length);
  }

  let frame = getDropsFrame(page);
  if (!frame) throw new Error('드롭스 관리 화면을 찾을 수 없습니다. 계정 연동을 다시 진행해주세요.');

  await frame.getByText('신규 캠페인 등록', { exact: true }).click();
  await page.waitForTimeout(1200);
  frame = getDropsFrame(page);

  // reward payout type
  await frame.locator('input.ant-select-input').first().click();
  await page.waitForTimeout(500);
  await frame.getByText('쿠폰 코드 유형 (선착순)', { exact: true }).first().click();
  await page.waitForTimeout(700);

  await frame.locator('#title').fill(row.campaignTitle);
  await frame.locator('#campaignId').fill(row.campaignId);

  if (config.campaignImagePath) {
    await frame.locator('input[type="file"]').first().setInputFiles(config.campaignImagePath);
    await page.waitForTimeout(800);
  }

  await frame.locator('#description').fill(config.description);

  // category / client id (cascader)
  await frame.locator('#category').click();
  await page.waitForTimeout(700);
  await frame.locator('.ant-cascader-menu-item', { hasText: config.categoryLabel }).click();
  await page.waitForTimeout(500);
  await frame.locator('.ant-cascader-menu-item', { hasText: config.clientId }).click();
  await page.waitForTimeout(500);

  await frame.locator('#pcLinkUrl').fill(config.pcLinkUrl);
  await frame.locator('#mobileLinkUrl').fill(config.mobileLinkUrl);

  await setAntDateTime(frame, page, frame.locator('#dateRange_startDate'), start.dateTitle, start.hour, start.minute);
  await setAntDateTime(frame, page, frame.locator('#dateRange_endDate'), end.dateTitle, end.hour, end.minute);

  await setTargetStreamers(frame, page, row.streamerUids);

  for (let i = 0; i < config.rewardTiers.length; i++) {
    const tier = config.rewardTiers[i];
    const usageGuide = tier.usageGuideTemplate.replace(/\{DEADLINE\}/g, validUntilLabel);
    const rewardId = tier.rewardIdTemplate.replace(/\{MMDD\}/g, dayMmdd);
    const couponFilePath = couponFiles[i];
    if (!couponFilePath) throw new Error(`${i + 1}번째 리워드용 쿠폰 파일 경로를 찾지 못했습니다.`);

    await fillRewardItem(
      frame,
      page,
      { name: tier.name, imagePath: tier.imagePath, usageGuide, rewardId, watchHour: tier.watchHour, watchMinute: tier.watchMinute },
      couponFilePath,
      validUntil.dateTitle
    );
    frame = getDropsFrame(page);
  }

  await frame.getByRole('button', { name: '등록', exact: true }).click();
  await page.waitForTimeout(1200);
  const confirmBtn = frame.getByRole('button', { name: '확인', exact: true });
  if ((await confirmBtn.count()) > 0) {
    await confirmBtn.click();
    await page.waitForTimeout(2000);
  }

  frame = getDropsFrame(page);
  const bodyText = await frame.locator('body').innerText();
  const idMatch = bodyText.match(new RegExp(`(\\d+)\\s*\\t?${row.campaignTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  return idMatch ? idMatch[1] : null;
}

module.exports = { LOGIN_URL, isFullyConnected, createCampaign, getDropsFrame };
