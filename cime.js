const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'https://developers.ci.me/drops';

// 윈도우 탐색기 등에서 경로를 복사하면 눈에 안 보이는 유니코드 방향 제어 문자가
// 앞에 붙어오는 경우가 있어, 파일 경로로 쓰기 전에 항상 제거한다.
function sanitizePath(p) {
  if (!p) return p;
  return String(p).replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').trim();
}

function parseKST(str) {
  // "YYYY-MM-DD HH:mm"
  const m = String(str).trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`잘못된 날짜 형식입니다 (YYYY-MM-DD HH:mm 형식이어야 함): "${str}"`);
  const [, y, mo, d, h, mi] = m;
  return { y: Number(y), mo: Number(mo), d: Number(d), h: Number(h), mi: Number(mi) };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// <input type="datetime-local"> 이 기대하는 값 형식: "YYYY-MM-DDTHH:mm"
function toLocalInputValue(p) {
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}`;
}

function addDays(p, days, timeStr) {
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  d.setUTCDate(d.getUTCDate() + days);
  const [h, mi] = String(timeStr || '23:59').split(':').map(Number);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h, mi };
}

function mmdd(p) {
  return `${pad2(p.mo)}${pad2(p.d)}`;
}

function koreanDeadlineLabel(p, timeStr) {
  return `${p.mo}월 ${p.d}일 ${timeStr}`;
}

function findCouponFolder(baseFolder, mmddStr) {
  if (!baseFolder) return null;
  baseFolder = sanitizePath(baseFolder);
  if (!fs.existsSync(baseFolder)) throw new Error(`쿠폰 상위 폴더를 찾을 수 없습니다: ${baseFolder}`);
  const entries = fs.readdirSync(baseFolder, { withFileTypes: true });
  const match = entries.find((e) => e.isDirectory() && e.name.includes(mmddStr));
  if (!match) throw new Error(`"${mmddStr}"가 포함된 하위 폴더를 찾을 수 없습니다 (${baseFolder} 안에서 검색)`);
  return path.join(baseFolder, match.name);
}

function findCouponFiles(folder, count) {
  const files = [];
  for (let i = 1; i <= count; i++) {
    const p = path.join(folder, `씨미_${i}.csv`);
    if (!fs.existsSync(p)) throw new Error(`쿠폰 파일을 찾을 수 없습니다: ${p}`);
    files.push(p);
  }
  return files;
}

async function isFullyConnected(page) {
  const url = page.url();
  if (!url.includes('developers.ci.me')) return false;
  try {
    await page.getByText('+ 새 캠페인', { exact: true }).first().waitFor({ timeout: 1500 });
    return true;
  } catch (_) {
    return false;
  }
}

// 애플리케이션/카테고리 드롭다운은 현재 계정에 등록된 게임이 하나뿐이라
// "선택"을 제외한 유일한 옵션을 그대로 선택한다.
async function selectOnlyOption(page, selector) {
  const value = await page.$eval(selector, (el) => {
    const opt = Array.from(el.options).find((o) => o.value);
    return opt ? opt.value : null;
  });
  if (!value) throw new Error(`${selector} 드롭다운에서 선택 가능한 옵션을 찾지 못했습니다.`);
  await page.selectOption(selector, value);
}

// 이전 캠페인 처리 도중 에러가 나면 생성 모달이 미완성 상태로 화면에 남아있을 수
// 있다. 그 상태로 다음 캠페인을 시작하면 "+ 새 캠페인" 버튼을 눌러도 아무 반응이
// 없어 보이므로, 매 캠페인 시작 전에 항상 닫아 둔다.
async function ensureClosedModal(page) {
  const stillOpen = await page.evaluate(() => !!document.querySelector('.modal-box'));
  if (stillOpen) {
    await page.getByText('닫기', { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function createCampaign(page, config, row) {
  const start = parseKST(row.startKST);
  const end = parseKST(row.endKST);
  const claimDeadlineDays = config.claimDeadlineDays ?? 1;
  const claimDeadlineTime = config.claimDeadlineTime || '23:59';
  const claim = addDays(end, claimDeadlineDays, claimDeadlineTime);
  const claimDeadlineLabel = koreanDeadlineLabel(claim, claimDeadlineTime);
  const dayMmdd = mmdd(start);

  let couponFiles = [];
  if (config.couponBaseFolder) {
    const folder = findCouponFolder(config.couponBaseFolder, dayMmdd);
    couponFiles = findCouponFiles(folder, config.rewardTiers.length);
  }

  await ensureClosedModal(page);

  await page.getByText('+ 새 캠페인', { exact: true }).click();
  await page.waitForTimeout(800);

  await selectOnlyOption(page, '#create-app');
  await page.waitForTimeout(300);
  await page.selectOption('#create-reward-group', 'COUPON');
  await page.waitForTimeout(300);
  await selectOnlyOption(page, '#create-category');
  await page.waitForTimeout(300);

  await page.fill('#create-title', row.campaignTitle);
  await page.fill('#create-description', config.description);

  const fileInputs = page.locator('input.FileUploadInput');
  if (config.campaignImagePath) {
    await fileInputs.nth(0).setInputFiles(sanitizePath(config.campaignImagePath));
    await page.waitForTimeout(500);
  }

  if (config.externalUrl) {
    await page.fill('#create-external-url', config.externalUrl);
  }

  await page.fill('#create-start-at', toLocalInputValue(start));
  await page.fill('#create-end-at', toLocalInputValue(end));
  await page.fill('#create-claim-available-at', toLocalInputValue(claim));

  // 보상 블록은 기본 1개 있으므로, 필요한 개수만큼 "+ 보상 추가"를 눌러 늘린다.
  for (let i = 1; i < config.rewardTiers.length; i++) {
    await page.getByText('+ 보상 추가', { exact: true }).click();
    await page.waitForTimeout(400);
  }

  for (let i = 0; i < config.rewardTiers.length; i++) {
    const tier = config.rewardTiers[i];
    const description = tier.description.replace(/\{DEADLINE\}/g, claimDeadlineLabel);
    await page.fill(`#create-reward-title-${i}`, tier.name);
    await page.fill(`#create-reward-description-${i}`, description);
    await page.selectOption(`#create-reward-type-${i}`, 'LIMITED_COUPON');
    await page.fill(`#create-reward-min-watch-time-${i}`, String(tier.minWatchMinutes));

    const expiryDays = tier.expiryDays ?? claimDeadlineDays;
    const expiryTime = tier.expiryTime || claimDeadlineTime;
    if (expiryDays !== null) {
      const expiry = addDays(end, expiryDays, expiryTime);
      await page.fill(`#create-reward-expired-at-${i}`, toLocalInputValue(expiry));
    }

    if (tier.imagePath) {
      await fileInputs.nth(i + 1).setInputFiles(sanitizePath(tier.imagePath));
      await page.waitForTimeout(400);
    }
  }

  await page.getByRole('button', { name: '생성', exact: true }).click();
  await page.waitForTimeout(1500);

  const stillOpen = await page.evaluate(() => !!document.querySelector('.modal-box'));
  if (stillOpen) {
    const bannerText = await page.evaluate(() => {
      const b = document.querySelector('.modal-box');
      return b ? b.innerText.slice(0, 300) : '';
    });
    throw new Error(`캠페인 생성에 실패했습니다 (필수 항목을 확인해주세요): ${bannerText}`);
  }

  if (couponFiles.length) {
    await uploadCoupons(page, row.campaignTitle, couponFiles);
  }
}

// 캠페인 생성(DRAFT 저장) 후 목록에서 방금 만든 캠페인을 다시 열어, 보상별로
// "쿠폰 관리" → CSV 선택 → 등록 순서로 쿠폰 코드를 업로드한다.
async function uploadCoupons(page, campaignTitle, couponFiles) {
  await page.getByText(campaignTitle, { exact: true }).first().click();
  await page.waitForTimeout(1000);

  for (let i = 0; i < couponFiles.length; i++) {
    const couponToggleBtn = page.getByText('쿠폰 관리', { exact: true }).nth(i);
    await couponToggleBtn.click();
    await page.waitForTimeout(500);

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByText('CSV 파일 선택', { exact: true }).last().click(),
    ]);
    await chooser.setFiles(couponFiles[i]);
    await page.waitForTimeout(1200);

    await page.getByText('등록', { exact: true }).last().click();
    await page.waitForTimeout(1500);

    // 다음 보상의 "쿠폰 관리"를 열기 전에 현재 패널을 닫아, 여러 개의
    // "등록"/"CSV 파일 선택" 버튼이 동시에 잡히는 문제를 막는다.
    await couponToggleBtn.click();
    await page.waitForTimeout(400);
  }

  await page.getByText('닫기', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(500);
}

module.exports = { LOGIN_URL, isFullyConnected, createCampaign };
