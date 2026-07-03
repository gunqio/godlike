// GODLIKE 面板服务器自动续期脚本
// 流程：登录 -> 进入服务器详情页 -> 关闭可能出现的广告弹窗
//      -> 点击 Renew -> 点击播放广告 -> 等待约240秒
//      -> 对比续期前后的倒计时 -> Telegram 通知结果
//
// 每一步都会保存截图到 ./screenshots 目录，工作流会把这个目录作为 Artifact 上传

// 用 playwright-extra + stealth 插件启动 chromium：YouTube 会通过 navigator.webdriver、
// CDP 控制特征等信号识别自动化浏览器并弹出"Sign in to confirm you're not a bot"验证墙，
// stealth 插件会隐藏掉这些常见指纹，降低被识别概率（但不是100%保证，IP信誉同样关键，见下方代理配置）
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs');
const path = require('path');
const https = require('https');

// ===== 配置（全部从环境变量读取） =====
const LOGIN_URL = 'https://ultra.panel.godlike.host/login';
const USERNAME = process.env.PANEL_USERNAME;
const PASSWORD = process.env.PANEL_PASSWORD;
// 可选：直接指定服务器地址，例如 https://ultra.panel.godlike.host/server/2a3af930
// 不填的话脚本会尝试在登录后自动点击 "My Servers" 进入第一台服务器
const SERVER_URL = process.env.SERVER_URL || '';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const AD_WAIT_SECONDS = parseInt(process.env.AD_WAIT_SECONDS || '240', 10);
// 可选：住宅代理配置。GitHub Actions 用的是数据中心 IP，YouTube 对这类 IP 反机器人检测更激进，
// 如果 stealth 插件还是过不了"Sign in to confirm you're not a bot"，建议配一个住宅代理。
// 不填这三个变量就不会启用代理，按原来的方式直接连
const PROXY_SERVER = process.env.PROXY_SERVER || ''; // 例如 http://1.2.3.4:8080
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

const SHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

let shotIndex = 0;
async function shot(page, label) {
  shotIndex++;
  const name = `${String(shotIndex).padStart(2, '0')}_${label}.png`;
  const filePath = path.join(SHOT_DIR, name);
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`📸 截图保存: ${name}`);
  } catch (e) {
    console.log(`⚠️ 截图失败(${label}): ${e.message}`);
  }
  return filePath;
}

// ===== Telegram 通知（文本） =====
function sendTelegramMessage(text) {
  return new Promise((resolve) => {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return resolve();
    const data = JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' });
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${TG_BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      }
    );
    req.on('error', (e) => {
      console.log('Telegram 文本发送失败: ' + e.message);
      resolve();
    });
    req.write(data);
    req.end();
  });
}

// ===== Telegram 通知（图片） =====
function sendTelegramPhoto(filePath, caption) {
  return new Promise((resolve) => {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID || !fs.existsSync(filePath)) return resolve();
    const boundary = '----GodlikeBoundary' + Date.now();
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    let head = '';
    head += `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TG_CHAT_ID}\r\n`;
    head += `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption || ''}\r\n`;
    head += `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`;
    const headBuf = Buffer.from(head, 'utf8');
    const tailBuf = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const payload = Buffer.concat([headBuf, fileBuffer, tailBuf]);

    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${TG_BOT_TOKEN}/sendPhoto`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': payload.length,
        },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      }
    );
    req.on('error', (e) => {
      console.log('Telegram 图片发送失败: ' + e.message);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

// ===== 时间字符串解析: "23h 10m 52s" -> 秒数 =====
function parseDurationToSeconds(text) {
  if (!text) return null;
  const h = /(\d+)\s*h/i.exec(text);
  const m = /(\d+)\s*m/i.exec(text);
  const s = /(\d+)\s*s/i.exec(text);
  if (!h && !m && !s) return null;
  return (h ? parseInt(h[1], 10) * 3600 : 0) + (m ? parseInt(m[1], 10) * 60 : 0) + (s ? parseInt(s[1], 10) : 0);
}

function formatSeconds(total) {
  const sign = total < 0 ? '-' : '';
  total = Math.abs(total);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${sign}${h}h ${m}m ${s}s`;
}

// 尝试关闭新手引导教程弹窗（Shepherd.js 蒙层，"MAIN MENU / Step x of 6"，会挡住点击）
async function tryDismissOnboardingTour(page) {
  const dismissSelectors = [
    'a:has-text("Skip for now")',
    'button:has-text("Skip for now")',
    'text=Skip for now',
    '.shepherd-cancel-icon',
    'button[aria-label="Close Tour" i]',
  ];
  let dismissed = false;
  for (const sel of dismissSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ timeout: 3000 }).catch(() => {});
        console.log(`✅ 已关闭新手引导弹窗: ${sel}`);
        dismissed = true;
        await page.waitForTimeout(500);
      }
    } catch (e) {
      // 继续尝试下一个选择器
    }
  }
  // 兜底：如果上面都没找到，直接按 Escape 试一下
  if (!dismissed) {
    try {
      const hasShepherd = await page
        .locator('.shepherd-modal-overlay-container, dialog.shepherd-element')
        .first()
        .isVisible({ timeout: 500 });
      if (hasShepherd) {
        await page.keyboard.press('Escape').catch(() => {});
      }
    } catch (e) {
      // 没有引导层，忽略
    }
  }
  return dismissed;
}

// 尝试关闭可能出现的广告弹窗/遮罩层（通用选择器，不同广告网络样式不同，按需补充）
async function tryCloseAdPopup(page) {
  const closeSelectors = [
    'button[aria-label="close" i]',
    'button[aria-label="Close" i]',
    '[class*="modal"] button:has-text("×")',
    '[class*="modal"] button:has-text("X")',
    'button:has-text("×")',
    'div[role="dialog"] button[class*="close" i]',
    '.fancybox-close',
    '[class*="ad-close" i]',
    '[class*="popup-close" i]',
  ];
  for (const sel of closeSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 })) {
        await el.click({ timeout: 2000 }).catch(() => {});
        console.log(`✅ 已尝试关闭广告弹窗: ${sel}`);
        return true;
      }
    } catch (e) {
      // 继续尝试下一个选择器
    }
  }
  return false;
}

(async () => {
  if (!USERNAME || !PASSWORD) {
    console.error('❌ 缺少 PANEL_USERNAME / PANEL_PASSWORD 环境变量');
    process.exit(1);
  }

  const launchOptions = { headless: true };
  if (PROXY_SERVER) {
    launchOptions.proxy = { server: PROXY_SERVER };
    if (PROXY_USERNAME) launchOptions.proxy.username = PROXY_USERNAME;
    if (PROXY_PASSWORD) launchOptions.proxy.password = PROXY_PASSWORD;
    console.log('🌐 已启用代理: ' + PROXY_SERVER);
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
  });

  // 广告网络经常会弹出新标签页，监听一下避免卡住主流程（不主动关闭，只记录）
  context.on('page', async (popup) => {
    console.log('🆕 检测到新标签页: ' + popup.url());
  });

  const page = await context.newPage();
  let renewSucceeded = false;
  let resultMessage = '';

  try {
    // ===== 第1步：打开登录页，点击 "Through Login/Password" =====
    console.log('▶️ 第1步: 打开登录页...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await shot(page, 'open_login_page');

    await page.getByText('Through Login/Password', { exact: false }).click({ timeout: 15000 });
    await page.waitForTimeout(1000);
    await shot(page, 'login_form_shown');

    // ===== 第2步：输入账号密码并登录 =====
    console.log('▶️ 第2步: 输入账号密码...');
    await page.getByPlaceholder('Username or Email').fill(USERNAME);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await shot(page, 'credentials_filled');

    await page.getByRole('button', { name: 'Login', exact: true }).click({ timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await shot(page, 'after_login');

    // ===== 第3步：进入服务器详情页 =====
    if (SERVER_URL) {
      console.log('▶️ 第3步: 跳转到指定服务器页面...');
      await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } else if (!/\/server\//.test(page.url())) {
      console.log('▶️ 第3步: 未配置 SERVER_URL，尝试进入 "My Servers"...');
      await page
        .getByText('My Servers', { exact: false })
        .first()
        .click({ timeout: 15000 })
        .catch(() => {});
      await page.waitForTimeout(1500);
      await page
        .locator('a[href*="/server/"]')
        .first()
        .click({ timeout: 15000 })
        .catch(() => {});
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await shot(page, 'server_page_loaded');

    // 关闭可能出现的新手引导教程蒙层（会挡住后续所有点击）
    console.log('▶️ 关闭新手引导教程（如果有）...');
    for (let i = 0; i < 3; i++) {
      const d = await tryDismissOnboardingTour(page);
      if (!d) break;
      await page.waitForTimeout(800);
    }
    await shot(page, 'onboarding_tour_dismissed');
    console.log('▶️ 第4步: 检测广告弹窗（最多10秒）...');
    let closedAny = false;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      const c = await tryCloseAdPopup(page);
      if (c) closedAny = true;
    }
    await shot(page, closedAny ? 'ad_popup_closed' : 'no_ad_popup');

    // ===== 第5步：记录续期前的倒计时文本 =====
    let beforeText = '';
    try {
      beforeText = (await page.getByText(/will be suspended in/i).first().innerText({ timeout: 10000 })).trim();
    } catch (e) {
      console.log('⚠️ 未能读取续期前的倒计时文本: ' + e.message);
    }
    console.log(`📋 续期前倒计时: ${beforeText}`);
    const beforeSeconds = parseDurationToSeconds(beforeText);

    // "Video will be available in ..." 是广告冷却提示，如果还没冷却完就不要点 Renew
    let cooldownText = '';
    try {
      cooldownText = (await page.getByText(/Video will be available in/i).first().innerText({ timeout: 3000 })).trim();
    } catch (e) {
      // 没有这个提示，说明现在可以续期
    }

    if (cooldownText && !/0h\s*0m\s*0s/i.test(cooldownText)) {
      resultMessage = `⏳ 还未到可续期时间\n冷却提示: ${cooldownText}\n服务器剩余: ${beforeText}`;
      console.log(resultMessage);
      await shot(page, 'still_in_cooldown');
    } else {
      // ===== 第6步：点击 Renew 按钮 =====
      console.log('▶️ 第6步: 点击 Renew 按钮...');
      await tryDismissOnboardingTour(page); // 保险起见再关一次，防止引导层重新出现挡住点击
      try {
        // 限定只匹配真正的 <button>，避免匹配到 "Renew Server" 标题文字
        await page.getByRole('button', { name: /^renew$/i }).first().click({ timeout: 15000 });
      } catch (e) {
        await page.locator('button:has-text("Renew")').first().click({ timeout: 15000 });
      }
      await page.waitForTimeout(2000);
      await shot(page, 'clicked_renew');

      // ===== 第7步：在弹出框中点击播放广告 =====
      console.log('▶️ 第7步: 寻找并点击播放广告按钮...');
      const playAdCandidates = [
        page.getByRole('button', { name: /watch/i }),
        page.getByRole('button', { name: /play/i }),
        page.getByText(/watch ad/i),
        page.getByText(/play ad/i),
      ];
      let played = false;
      for (const cand of playAdCandidates) {
        try {
          if (await cand.first().isVisible({ timeout: 2000 })) {
            await cand.first().click({ timeout: 5000 });
            played = true;
            console.log('✅ 已点击播放广告按钮');
            break;
          }
        } catch (e) {
          // 继续尝试下一个候选
        }
      }
      await shot(page, played ? 'ad_play_clicked' : 'ad_play_button_not_found');

      // ===== 第7.5步：在 "Watch Video to Renew" 弹窗中点击视频缩略图中间的真正播放按钮 =====
      // 已确认这个视频不是真正的 YouTube iframe（page.frames() 里没有任何 youtube.com 的 frame），
      // 而是纯 HTML/CSS 做的假缩略图（点击后才会真正注入播放）。
      // 思路改成：用视频标题这段唯一可见文字定位，再一层层往上找父容器，
      // 找到第一个"宽高足够大、看起来是整个缩略图"的容器，点它的正中心。
      console.log('▶️ 第7.5步: 点击视频开始播放...');
      let videoStarted = false;

      // 诊断信息：打印页面当前所有 frame 的地址，留着方便确认
      try {
        const allFrames = page.frames();
        console.log(`ℹ️ 当前页面共有 ${allFrames.length} 个 frame:`);
        allFrames.forEach((f, i) => console.log(`   [${i}] ${f.url() || '(空白frame)'}`));
      } catch (e) {
        // 忽略
      }

      // 方案一：以视频标题文字为锚点，向上查找尺寸足够大的祖先容器（即整个缩略图区域），点击其中心
      try {
        let anchor = page.getByText('TODO LO QUE DEBES SABER', { exact: false }).first();
        let videoBox = null;
        let foundLevel = -1;
        for (let level = 0; level < 8; level++) {
          const box = await anchor.boundingBox().catch(() => null);
          if (box && box.width >= 400 && box.height >= 200) {
            videoBox = box;
            foundLevel = level;
            break;
          }
          anchor = anchor.locator('xpath=..');
        }
        if (videoBox) {
          await page.mouse.click(videoBox.x + videoBox.width / 2, videoBox.y + videoBox.height / 2);
          videoStarted = true;
          console.log(
            `✅ 已点击视频缩略图区域（向上找了 ${foundLevel} 层），坐标 (${Math.round(videoBox.x + videoBox.width / 2)}, ${Math.round(videoBox.y + videoBox.height / 2)})，尺寸 ${Math.round(videoBox.width)}x${Math.round(videoBox.height)}`
          );
        } else {
          console.log('⚠️ 没能找到足够大的缩略图容器（向上找了8层都不够大）');
        }
      } catch (e) {
        console.log('⚠️ 以标题文字定位缩略图失败: ' + e.message.split('\n')[0]);
      }

      // 方案二：如果方案一没找到视频标题文字（比如视频换了），尝试找 YouTube frame（万一点了之后才会出现）
      if (!videoStarted) {
        try {
          const ytFrameHandle = page.frames().find((f) => /youtube/i.test(f.url()));
          if (ytFrameHandle) {
            await ytFrameHandle.click('body', { timeout: 8000 });
            videoStarted = true;
            console.log('✅ 已通过 frame.click(body) 点击 YouTube frame: ' + ytFrameHandle.url());
          }
        } catch (e) {
          console.log('⚠️ frame.click(body) 失败: ' + e.message.split('\n')[0]);
        }
      }

      // 方案三：遍历所有匹配 iframe[src*="youtube"] 的元素，逐个点击中心坐标（兜底）
      if (!videoStarted) {
        try {
          const iframeLocators = page.locator('iframe[src*="youtube"]');
          const count = await iframeLocators.count();
          console.log(`ℹ️ 找到 ${count} 个 iframe[src*="youtube"]，逐个尝试点击`);
          for (let i = 0; i < count; i++) {
            const el = iframeLocators.nth(i);
            const box = await el.boundingBox().catch(() => null);
            if (box) {
              console.log(`   [${i}] 坐标 (${Math.round(box.x + box.width / 2)}, ${Math.round(box.y + box.height / 2)}) 尺寸 ${Math.round(box.width)}x${Math.round(box.height)}`);
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
              await page.waitForTimeout(1000);
            } else {
              console.log(`   [${i}] 不可见，跳过`);
            }
          }
          videoStarted = count > 0;
        } catch (e) {
          console.log('⚠️ 遍历点击 iframe 失败: ' + e.message);
        }
      }

      // 方案四：兜底，针对常见的自定义播放按钮组件 class 名
      if (!videoStarted) {
        const videoPlayCandidates = [
          page.locator('button.lty-playbtn'),
          page.locator('[class*="lty-playbtn" i]'),
          page.locator('lite-youtube'),
          page.locator('[aria-label="Play" i]'),
          page.locator('[class*="play-button" i]'),
          page.locator('[class*="play-btn" i]'),
        ];
        for (const cand of videoPlayCandidates) {
          try {
            const el = cand.first();
            if (await el.isVisible({ timeout: 2000 })) {
              await el.click({ timeout: 5000 });
              videoStarted = true;
              console.log('✅ 已点击视频播放按钮（兜底选择器）');
              break;
            }
          } catch (e) {
            // 继续尝试下一个候选
          }
        }
      }
      await page.waitForTimeout(3000);
      await shot(page, videoStarted ? 'video_play_clicked' : 'video_play_not_found');

      // 验证视频是否真的在播放：对比几秒间隔内的播放进度百分比是否在变化
      // 注意：页面顶部促销横幅里也有"-50%"这种带百分号的文字，必须把搜索范围限定在 "Watch the video" 这句话附近，
      // 避免像上次一样误抓到横幅文字
      try {
        const progressArea = page.getByText(/Watch the video for \d+ seconds/i).first().locator('xpath=preceding-sibling::*[1]');
        const progress1 = (await progressArea.innerText({ timeout: 4000 })).trim();
        await page.waitForTimeout(8000);
        const progress2 = (await progressArea.innerText({ timeout: 4000 })).trim();
        console.log(`📊 播放进度检测: ${progress1} -> ${progress2}`);
        if (progress1 === progress2) {
          console.log('⚠️ 警告：播放进度没有变化，视频可能没有真正开始播放！');
        }
      } catch (e) {
        console.log('⚠️ 未能读取播放进度百分比，跳过该项检测: ' + e.message);
      }

      // ===== 第8步：等待广告播放约240秒 =====
      console.log(`▶️ 第8步: 等待广告播放 ${AD_WAIT_SECONDS} 秒...`);
      await page.waitForTimeout(AD_WAIT_SECONDS * 1000);
      await shot(page, 'after_ad_wait');

      // 广告播完后可能还有一个"领取/确认/关闭"按钮，尝试点一下（没有也不报错）
      const claimCandidates = [
        page.getByRole('button', { name: /claim/i }),
        page.getByRole('button', { name: /confirm/i }),
        page.getByRole('button', { name: /close/i }),
      ];
      for (const cand of claimCandidates) {
        try {
          if (await cand.first().isVisible({ timeout: 2000 })) {
            await cand.first().click({ timeout: 5000 });
            console.log('✅ 已点击领取/确认按钮');
            await page.waitForTimeout(2000);
            break;
          }
        } catch (e) {
          // 没有这个按钮就跳过
        }
      }

      // 刷新确保倒计时是最新数据，并等待页面真正渲染出内容后再截图（避免截到加载圈）
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      try {
        await page.getByText(/will be suspended in/i).first().waitFor({ state: 'visible', timeout: 20000 });
      } catch (e) {
        console.log('⚠️ 刷新后等待倒计时元素超时，可能页面加载较慢: ' + e.message);
      }
      await page.waitForTimeout(1500);
      await shot(page, 'final_state');

      // ===== 第9步：读取续期后的倒计时并对比 =====
      let afterText = '';
      try {
        afterText = (await page.getByText(/will be suspended in/i).first().innerText({ timeout: 10000 })).trim();
      } catch (e) {
        console.log('⚠️ 未能读取续期后的倒计时文本: ' + e.message);
      }
      console.log(`📋 续期后倒计时: ${afterText}`);
      const afterSeconds = parseDurationToSeconds(afterText);

      if (beforeSeconds !== null && afterSeconds !== null) {
        const diff = afterSeconds - beforeSeconds;
        if (diff > 0) {
          renewSucceeded = true;
          resultMessage = `✅ 续期成功！\n续期前: ${beforeText}\n续期后: ${afterText}\n增加了: ${formatSeconds(diff)}`;
        } else {
          resultMessage = `⚠️ 续期后时间未增加，可能没有续期成功\n续期前: ${beforeText}\n续期后: ${afterText}`;
        }
      } else {
        resultMessage = `⚠️ 无法准确读取倒计时进行比较\n续期前文本: ${beforeText || '未获取到'}\n续期后文本: ${afterText || '未获取到'}`;
      }
      console.log(resultMessage);
    }
  } catch (err) {
    resultMessage = `❌ 续期流程出现异常: ${err.message}`;
    console.error(resultMessage);
    await shot(page, 'error_state').catch(() => {});
  } finally {
    // ===== 发送 Telegram 通知（文本 + 最后一张截图） =====
    await sendTelegramMessage(`🎮 GODLIKE 服务器续期结果\n\n${resultMessage}`);
    try {
      const shots = fs.readdirSync(SHOT_DIR).sort();
      if (shots.length > 0) {
        await sendTelegramPhoto(path.join(SHOT_DIR, shots[shots.length - 1]), resultMessage.split('\n')[0]);
      }
    } catch (e) {
      console.log('读取截图目录失败: ' + e.message);
    }
    await browser.close();
    console.log(renewSucceeded ? '🎉 任务完成: 续期成功' : '🏁 任务完成');
  }
})();
