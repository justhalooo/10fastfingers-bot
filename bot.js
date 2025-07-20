import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import prompts from 'prompts';
import chalk from 'chalk';
import ora from 'ora';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import readline from 'readline';

puppeteer.use(StealthPlugin());

const CONFIG = {
  headless: true,
  baseUrl: 'https://10fastfingers.com',
  languageMap: { english: 'english', indonesian: 'indonesian' },
  cookieDir: path.join(process.cwd(), 'profiles'),
  typing: {
    defaultTargetWPM: 105,
    perCharVarianceMs: [25, 80],
    wordDelayEveryN: 10,
    extraWordDelayRange: [150, 500],
    mistakeProbability: 0.03,
    mistakeMaxChars: 5,
    wrongWordProbability: 0.08
  }
};

await fs.ensureDir(CONFIG.cookieDir);

let currentWPM = CONFIG.typing.defaultTargetWPM;
let wpmSequence = [];

function generateControlJson(wordsLength) {
  const neededEntries = Math.ceil(wordsLength / 12) + 5;
  const sequence = [];

  for (let i = 0; i < neededEntries; i++) {
    let wpm;
    const spikeChance = Math.random();

    if (spikeChance < 0.05) {
      wpm = randInt(140, 150);
    } else if (spikeChance < 0.10) {
      wpm = randInt(135, 140);
    } else if (spikeChance < 0.15) {
      wpm = randInt(130, 135);
    } else {
      wpm = randInt(120, 130);
    }

    sequence.push(wpm);
  }

  return sequence;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randFloat(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.random() * arr.length | 0]; }

async function saveCookies(page, profileName) {
  const cookies = await page.cookies();
  const file = path.join(CONFIG.cookieDir, profileName + '.cookies.json');
  await fs.writeJSON(file, cookies, { spaces: 2 });
}

async function loadCookies(page, profileName) {
  const file = path.join(CONFIG.cookieDir, profileName + '.cookies.json');
  if (await fs.pathExists(file)) {
    const cookies = await fs.readJSON(file);
    for (const c of cookies) {
      try { await page.setCookie(c); } catch (e) {}
    }
    return true;
  }
  return false;
}

function computeCharBaseDelay(targetWPM) {
  return 60000 / (targetWPM * 5);
}

async function ensureLogin(page, { username, password, profile }) {
  const spinner = ora('Checking login session...').start();
  const isLogged = async () => page.evaluate(() => !!document.querySelector('a[href*="logout"], a[href*="/user/logout"], .user-info, a[href*="/profile"], .navigation_user'));
  await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  if (await isLogged()) { spinner.succeed('Already logged in (cookie still valid)'); return true; }

  const loginTriggers = [
    'a[href*="/login"]', 'a.login', 'button.login', 'a[href*="/user/login"]',
    'a.navbar-login', 'li.login a', 'div.login a'
  ];
  for (const sel of loginTriggers) {
    const el = await page.$(sel);
    if (el) { await el.click(); await sleep(1500); break; }
  }

  if (!(await page.$('input[type="password"], form[action*="login"] input'))) {
    await page.goto(CONFIG.baseUrl + '/login', { waitUntil: 'domcontentloaded' });
    await sleep(1200);
  }

  const usernameSelectors = [ '#UserUsername', 'input#username', 'input[name="username"]', 'input[name="user[username]"]', 'input[name="data[User][username]"]', 'input[type="text"][name*="user"]', 'input[type="email"]', 'form[action*="login"] input[type="text"]', 'form[action*="login"] input[type="email"]' ];
  const passwordSelectors = [ '#UserPassword', 'input#password', 'input[name="password"]', 'input[name="user[password]"]', 'input[name="data[User][password]"]', 'form[action*="login"] input[type="password"]', 'input[type="password"]' ];
  const submitSelectors = [ 'button[type="submit"]', 'input[type="submit"]', 'form[action*="login"] button', 'form[action*="login"] input[type="submit"]', 'button.login', 'button.btn-primary' ];

  async function findFirst(pageOrFrame, selectors) {
    for (const sel of selectors) { if (await pageOrFrame.$(sel)) return sel; }
    return null;
  }

  let uSel = await findFirst(page, usernameSelectors);
  let pSel = await findFirst(page, passwordSelectors);

  if (!uSel || !pSel) {
    const frames = page.mainFrame().childFrames();
    for (const f of frames) {
      if (!uSel) uSel = await findFirst(f, usernameSelectors);
      if (!pSel) pSel = await findFirst(f, passwordSelectors);
    }
  }

  spinner.text = 'Filling in credentials...';
  await page.click(uSel, { clickCount: 3 }).catch(() => {});
  await page.type(uSel, username, { delay: randInt(25, 70) });
  await page.click(pSel, { clickCount: 3 }).catch(() => {});
  await page.type(pSel, password, { delay: randInt(25, 70) });

  let sSel = await findFirst(page, submitSelectors);
  if (!sSel) {
    const frames = page.mainFrame().childFrames();
    for (const f of frames) {
      sSel = await findFirst(f, submitSelectors);
      if (sSel) break;
    }
  }

  spinner.text = 'Submitting login...';
  if (sSel) {
    try {
      await Promise.all([
        page.click(sSel).catch(() => {}),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {})
      ]);
    } catch (_) {}
  } else {
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
  }

  if (!(await isLogged())) {
    const loginError = await page.evaluate(() => {
      const err = document.querySelector('.error, .alert-danger, .flash-error');
      return err ? err.textContent.trim() : null;
    });
    if (loginError) console.log(chalk.red('Login error message: ' + loginError));
    await fs.writeFile(path.join(CONFIG.cookieDir, 'last_login_page.html'), await page.content());
    spinner.fail('Login failed / UI changed.');
    return false;
  }

  spinner.succeed('Login successful');
  await saveCookies(page, profile);
  return true;
}

async function getWordList(page) {
  return await page.evaluate(() => {
    const arr = [];
    const container = document.querySelector('#row1');
    if (container) {
      container.querySelectorAll('span').forEach(s => {
        const t = (s.textContent || '').trim();
        if (t) arr.push(t);
      });
    }
    if (!arr.length) {
      const dataDiv = document.querySelector('[data-words]');
      if (dataDiv) {
        try {
          const list = dataDiv.getAttribute('data-words').split('|');
          list.forEach(w => w && arr.push(w));
        } catch (_) {}
      }
    }
    return arr;
  });
}

async function openMode(page, mode, language) {
  const langSlug = CONFIG.languageMap[language] || 'english';
  let url = '';
  if (mode === 'basic') url = `/typing-test/${langSlug}`;
  else if (mode === 'advanced') url = `/advanced-typing-test/${langSlug}`;
  else if (mode === 'competition') url = '/competitions';
  await page.goto(CONFIG.baseUrl + url, { waitUntil: 'networkidle2' });
}

async function injectFinishWatcher(page) {
  await page.evaluate(() => {
    if (window.__ffWatcherInstalled) return;
    window.__ff_test_state = {
      done: false,
      lastCorrect: 0,
      lastTimeStr: '',
      startTime: Date.now(),
      lastSpanCount: 0,
      stagnationMs: 0
    };
    function scan() {
      try {
        const timerEl = document.querySelector('#timer');
        const t = timerEl ? timerEl.textContent.trim() : '';
        const resultPanel = document.querySelector('#result, .result');
        const container = document.querySelector('#row1');
        const spans = container ? container.querySelectorAll('span.correct').length : 0;
        if (spans > window.__ff_test_state.lastSpanCount) {
          window.__ff_test_state.lastSpanCount = spans;
          window.__ff_test_state.stagnationMs = 0;
        } else {
          window.__ff_test_state.stagnationMs += 150;
        }
        if (t === '0:00' || resultPanel) window.__ff_test_state.done = true;
        window.__ff_test_state.lastCorrect = spans;
        window.__ff_test_state.lastTimeStr = t;
      } catch (e) {}
    }
    scan();
    window.__ff_timerInt = setInterval(scan, 150);
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
    window.__ffWatcherInstalled = true;
  });
}

async function getTestState(page) {
  return await page.evaluate(() => window.__ff_test_state ? ({ ...window.__ff_test_state }) : null);
}

async function typeWords(page, words, wpmSequence) {
  let wpmIdx = 0;
  currentWPM = wpmSequence.length > 0 ? wpmSequence[0] : CONFIG.typing.defaultTargetWPM;

  await page.waitForSelector('#inputfield', { timeout: 20000 });
  await injectFinishWatcher(page);

  const inputSel = '#inputfield';
  const startTs = Date.now();
  let typedChars = 0;
  let correctWords = 0;
  let wrongWords = 0;

  const kP = 0.12, kI = 0.025, kD = 0.08;
  const jitter = [4, 20];
  let prevError = 0, integral = 0;

  function elapsedMin() { return (Date.now() - startTs) / 60000; }
  function estWPM() { const m = elapsedMin(); return m <= 0 ? 0 : (typedChars / 5) / m; }
  async function isDone() { const st = await getTestState(page); return st && st.done; }
  async function forceBlur() { await page.evaluate(() => { const i = document.querySelector('#inputfield'); if (i) i.blur(); }); }

  const safetyMs = 70000;

  for (let wi = 0; wi < words.length; wi++) {
    if (Date.now() - startTs > safetyMs) break;
    if (await isDone()) break;

    if (wpmSequence.length && wi % 12 === 0) {
      currentWPM = wpmSequence[Math.min(wpmIdx, wpmSequence.length - 1)];
      console.log(chalk.magenta(`[AUTO] currentWPM from generated sequence: ${currentWPM} [word ${wi + 1}]`));
      wpmIdx++;
    }

    let wordToType = words[wi];
    let isWrongWord = false;

    if (Math.random() < CONFIG.typing.wrongWordProbability) {
      const wrongWord = wordToType + pick('abcdefghijklmnopqrstuvwxyz');
      console.log(chalk.red(`[Simulate] Wrong word injected: ${wrongWord}`));
      wordToType = wrongWord;
      isWrongWord = true;
    }

    for (let ci = 0; ci < wordToType.length; ci++) {
      if (await isDone()) break;
      const current = estWPM();
      const error = currentWPM - current;
      integral += error;
      const derivative = error - prevError;
      prevError = error;
      let factor = 1 + kP * error + kI * integral + kD * derivative;
      factor = Math.max(0.4, Math.min(2.2, factor));
      let delay = 60000 / (currentWPM * 5) + randInt(jitter[0], jitter[1]);
      delay = Math.max(8, Math.min(220, delay));

      await page.type(inputSel, wordToType[ci], { delay });
      typedChars++;
    }

    if (await isDone()) break;
    await page.type(inputSel, ' ', { delay: randInt(12, 35) });

    if (isWrongWord) wrongWords++;
    else correctWords++;
  }

  await forceBlur();

  const totalWords = correctWords + wrongWords;
  const accuracy = totalWords > 0 ? (correctWords / totalWords * 100).toFixed(2) : 0;

  const finalWPM = estWPM().toFixed(2);
  console.log(chalk.green(`[DONE] Estimated WPM: ${finalWPM} (Target ${currentWPM})`));
  console.log(`Accuracy: ${accuracy}%`);
  console.log(`Correct words: ${correctWords}`);
  console.log(`Wrong words: ${wrongWords}`);
}

async function handleCompetition(page, language) {
  const comps = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.competition_list tbody tr'));
    return rows.map((r, idx) => {
      const link = r.querySelector('a[href*="/competition/"]');
      const title = link ? link.textContent.trim() : `Competition ${idx + 1}`;
      const href = link ? link.href : null;
      const slots = r.textContent.match(/\d+\s*\/\s*\d+/)?.[0] || '';
      return { title, href, slots };
    }).filter(c => c.href);
  });

  if (!comps.length) {
    console.log(chalk.red('No available competitions found.'));
    return;
  }

  console.log(chalk.cyan('\nAvailable Competitions:'));
  comps.forEach((c, i) => console.log(`${i + 1}. ${c.title} (${c.slots})`));

  const { compIndex } = await prompts({
    type: 'number',
    name: 'compIndex',
    message: 'Select competition (number):',
    initial: 1,
    validate: v => (v >= 1 && v <= comps.length) ? true : 'Invalid number'
  });

  const chosen = comps[compIndex - 1];
  console.log(chalk.yellow('Opening competition: ') + chosen.title);
  await page.goto(chosen.href, { waitUntil: 'networkidle2' });
  const joinBtn = await page.$('a[href*="/competition/"].btn, a.join, button.join');
  if (joinBtn) {
    try {
      await Promise.all([
        joinBtn.click(),
        page.waitForNavigation({ waitUntil: 'networkidle2' })
      ]);
    } catch (_) {}
  }

  const words = await getWordList(page);
  console.log(chalk.magenta(`Total competition words: ${words.length}`));
  await typeWords(page, words, wpmSequence);
}

async function main() {
  console.log(chalk.bold.green('\n=== 10FastFingers Automation Bot ===\n'));
  const onCancel = () => { 
    console.log(chalk.red('Cancelled by user.')); 
    process.exit(1); 
  };

  try {
    const controlContent = fs.readFileSync(CONTROL_FILE, 'utf-8');
    const parsed = JSON.parse(controlContent);
    if (Array.isArray(parsed)) {
      wpmSequence = parsed;
      console.log(chalk.magenta(`[AUTO] Loaded WPM sequence at start: ${wpmSequence.join(', ')}`));
    }
  } catch (err) {
    console.log(chalk.yellow('control.json not found or not an array, ignoring.'));
  }

  let keepRunning = true;
  while (keepRunning) {
    const answers = await prompts([
      { type: 'text', name: 'profile', message: 'Profile name?', initial: 'default' },
      { type: 'toggle', name: 'headless', message: 'Headless mode?', initial: true, active: 'YES', inactive: 'NO' },
      { type: 'select', name: 'mode', message: 'Select Mode:', choices: [
        { title: 'Basic Typing Test', value: 'basic' },
        { title: 'Advanced Typing Test', value: 'advanced' },
        { title: 'Competition', value: 'competition' }
      ]},
      { type: 'select', name: 'language', message: 'Language:', choices: [
        { title: 'English', value: 'english' },
        { title: 'Indonesian', value: 'indonesian' }
      ]},
      { type: 'select', name: 'wpmPreset', message: 'Choose typing style:', choices: [
        { title: 'Human - Normal (100-115 WPM)', value: 'normal' },
        { title: 'Human - Fatigue (90-110 WPM)', value: 'fatigue' },
        { title: 'Pro - Fast player (130-145 WPM)', value: 'fast' },
        { title: 'Random Natural Feel (100-140 WPM)', value: 'random' },
        { title: 'Gamer Style (Fast start, slow end)', value: 'gamer' },
        { title: 'Beginner Style (85-100 WPM)', value: 'beginner' }
      ]}
    ], { onCancel });

    const browser = await puppeteer.launch({
      headless: answers.headless ? 'new' : false,
      args: ['--no-sandbox'],
      defaultViewport: null
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 800 });

    let loggedIn = false;
    if (await loadCookies(page, answers.profile)) {
      await page.goto(`${CONFIG.baseUrl}/user/4290642/`, { waitUntil: 'networkidle2' });
      await sleep(2000);
      loggedIn = await page.evaluate(() => !!document.querySelector('a[href*="logout"], a[href*="/user/logout"], .user-info, a[href*="/profile"], .navigation_user'));
    }

    if (!loggedIn) {
      const credentials = await prompts([
        { type: 'text', name: 'username', message: 'Username / Email:', validate: v => v ? true : 'Required' },
        { type: 'password', name: 'password', message: 'Password:', validate: v => v ? true : 'Required' }
      ], { onCancel });

      loggedIn = await ensureLogin(page, {
        username: credentials.username,
        password: credentials.password,
        profile: answers.profile
      });

      if (!loggedIn) {
        console.log(chalk.red('Exit due to failed login.'));
        await browser.close();
        return;
      }
    } else {
      console.log(chalk.green('Auto-login via cookie successful.'));
    }

    await openMode(page, answers.mode, answers.language);

    if (answers.mode === 'competition') {
      await handleCompetition(page, answers.language);
    } else {
      const words = await getWordList(page);
      console.log(chalk.cyan(`Total test words: ${words.length}`));

      const wordCount = words.length;
      wpmSequence = [];

      if (answers.wpmPreset === 'normal') {
        wpmSequence = Array(Math.ceil(wordCount / 12) + 5).fill(0).map(() => randInt(100, 115));
      } else if (answers.wpmPreset === 'fatigue') {
        wpmSequence = Array(Math.ceil(wordCount / 12) + 5).fill(0).map((_, idx) => Math.max(90, 110 - Math.floor(idx / 4)));
      } else if (answers.wpmPreset === 'fast') {
        wpmSequence = Array(Math.ceil(wordCount / 12) + 5).fill(0).map(() => randInt(130, 145));
      } else if (answers.wpmPreset === 'random') {
        wpmSequence = Array(Math.ceil(wordCount / 12) + 5).fill(0).map(() => randInt(100, 140));
      } else if (answers.wpmPreset === 'gamer') {
        wpmSequence = Array(Math.ceil(wordCount / 12) + 5).fill(0).map((_, idx) => {
          if (idx < 3) return randInt(135, 145);      // Fast start
          else if (idx < 7) return randInt(120, 125); // Mid stable
          else return randInt(110, 115);              // Slow end
        });
      } else if (answers.wpmPreset === 'beginner') {
        wpmSequence = Array(Math.ceil(wordCount / 12) + 5).fill(0).map(() => randInt(85, 100));
      }

      console.log(chalk.magenta(`[AUTO] Generated preset WPM sequence: ${wpmSequence.join(', ')}`));
      await typeWords(page, words, wpmSequence);
    }

    const { ulangi } = await prompts({
      type: 'text',
      name: 'ulangi',
      message: 'Run again? (y/N)',
      initial: 'N'
    }, { onCancel });

    if (!ulangi || ulangi.toLowerCase() !== 'y') {
      keepRunning = false;
      console.log(chalk.green('Closing browser...'));
    }

    await browser.close();
  }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
