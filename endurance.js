const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPORT_URL = process.argv[2];
const TARGET_COUNTERS = ['Process - Handle Count', 'Process - Private Bytes'];
const PRIVATE_BYTES_COUNTER = 'PROCESS - PRIVATE BYTES';
const WAIT_AFTER_PAGE_LOAD_MS = 1000;
const WAIT_AFTER_HARDWARE_MS = 300;
const WAIT_AFTER_COUNTER_MS = 1500;
const COUNTER_TIMEOUT_MS = 30000;
const CHART_TIMEOUT_MS = 10000;
const BYTES_PER_MB = 1024 * 1024;

if (!REPORT_URL) {
  console.error('URL do report nao informada. Uso: node endurance.js "<URL_DO_REPORT>"');
  process.exit(1);
}

function normalize(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}
function unique(values) { return [...new Set(values)]; }
function isPrivateBytes(counter) { return normalize(counter) === PRIVATE_BYTES_COUNTER; }
function sendUiEvent(type, payload = {}) {
  if (typeof process.send !== 'function' || !process.connected) return;
  try { process.send({ type, ...payload }); }
  catch (error) { console.log(`[AVISO] Nao foi possivel atualizar a UI: ${error.message}`); }
}
function classifyIncrease(increaseMB) {
  if (increaseMB > 550) return 'HIGH';
  if (increaseMB > 100) return 'MEDIUM';
  return 'LOW';
}
function buildTabId(index) { return `chart-${index + 1}`; }
function buildChartName(hardware, action, processName, counter) {
  return `${hardware} - ${action} ${processName} ${counter}`.replace(/\s+/g, ' ').trim();
}

/*
  CanvasJS does not expose a global list of created charts. This initialization
  script runs before the report scripts and wraps CanvasJS.Chart so every chart
  instance created by the report is registered without changing its behavior.
*/
async function installCanvasJsCapture(page) {
  await page.addInitScript(() => {
    const registryName = '__enduranceCanvasJSCharts';
    window[registryName] = window[registryName] || [];

    const wrapCanvasJS = canvasJS => {
      if (!canvasJS || typeof canvasJS.Chart !== 'function' || canvasJS.Chart.__enduranceWrapped) return canvasJS;
      const OriginalChart = canvasJS.Chart;
      function WrappedChart(...args) {
        const chart = Reflect.construct(OriginalChart, args, new.target || WrappedChart);
        try { window[registryName].push(chart); } catch (_) {}
        return chart;
      }
      Object.setPrototypeOf(WrappedChart, OriginalChart);
      WrappedChart.prototype = OriginalChart.prototype;
      Object.getOwnPropertyNames(OriginalChart).forEach(name => {
        if (['length', 'name', 'prototype'].includes(name)) return;
        try { Object.defineProperty(WrappedChart, name, Object.getOwnPropertyDescriptor(OriginalChart, name)); } catch (_) {}
      });
      Object.defineProperty(WrappedChart, '__enduranceWrapped', { value: true });
      canvasJS.Chart = WrappedChart;
      return canvasJS;
    };

    let currentCanvasJS;
    try {
      currentCanvasJS = window.CanvasJS;
      Object.defineProperty(window, 'CanvasJS', {
        configurable: true,
        enumerable: true,
        get() { return currentCanvasJS; },
        set(value) { currentCanvasJS = wrapCanvasJS(value); }
      });
      if (currentCanvasJS) currentCanvasJS = wrapCanvasJS(currentCanvasJS);
    } catch (_) {
      if (window.CanvasJS) wrapCanvasJS(window.CanvasJS);
    }

    const timer = setInterval(() => {
      try {
        if (window.CanvasJS) wrapCanvasJS(window.CanvasJS);
        if (window[registryName].length > 0) clearInterval(timer);
      } catch (_) {}
    }, 50);
    setTimeout(() => clearInterval(timer), 30000);
  });
}

async function waitForReport(page) {
  await installCanvasJsCapture(page);
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('#tableHardware input[type="checkbox"]').first().waitFor({ state: 'attached', timeout: 30000 });
  await page.locator('#tableActions input[type="checkbox"]').first().waitFor({ state: 'attached', timeout: 30000 });
  await page.waitForTimeout(WAIT_AFTER_PAGE_LOAD_MS);
}
async function readInitialValues(page, tableSelector) {
  return page.locator(`${tableSelector} input[type="checkbox"]`).evaluateAll(elements => elements.map(element => element.value).filter(Boolean));
}
async function findExactCheckbox(page, tableSelector, expectedValue) {
  const checkboxes = page.locator(`${tableSelector} input[type="checkbox"]`);
  for (let index = 0; index < await checkboxes.count(); index++) {
    const checkbox = checkboxes.nth(index);
    if ((await checkbox.getAttribute('value')) === expectedValue) return checkbox;
  }
  return null;
}
async function clickExactCheckbox(page, tableSelector, value, roleName) {
  const checkbox = await findExactCheckbox(page, tableSelector, value);
  if (!checkbox) { console.log(`  [ERRO] ${roleName} nao encontrado: ${value}`); return false; }
  await checkbox.scrollIntoViewIfNeeded();
  if (!(await checkbox.isChecked())) await checkbox.click();
  return true;
}
async function clearInitialSelections(page) {
  const checked = page.locator('#tableHardware input[type="checkbox"]:checked, #tableActions input[type="checkbox"]:checked');
  let safety = 0;
  while (await checked.count() > 0 && safety < 100) {
    await checked.first().click();
    await page.waitForTimeout(50);
    safety++;
  }
}
async function waitForExactCounter(page, counterName) {
  const deadline = Date.now() + COUNTER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const counter = await findExactCheckbox(page, '#tableCounters', counterName);
    if (counter && await counter.isVisible().catch(() => false) && await counter.isEnabled().catch(() => false)) return counter;
    await page.waitForTimeout(250);
  }
  return null;
}
async function selectExactCounter(page, counterName) {
  const counter = await waitForExactCounter(page, counterName);
  if (!counter) { console.log(`  [ERRO] Counter exato nao encontrado: ${counterName}`); return false; }
  await counter.scrollIntoViewIfNeeded();
  if (!(await counter.isChecked())) await counter.click();
  await page.waitForTimeout(WAIT_AFTER_COUNTER_MS);
  return true;
}

async function extractCanvasJsSeries(page) {
  const deadline = Date.now() + CHART_TIMEOUT_MS;
  let diagnostics = {};
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => {
      // These helpers must exist inside page.evaluate because this callback runs
      // in the report browser context, not in the Node.js context.
      const firstDefinedInPage = (...values) =>
        values.find(value => value !== undefined && value !== null && String(value).trim() !== '');

      const stripMarkupInPage = value => String(value || '')
        .replace(/<br\s*\/?>(?=.)/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .trim();

      const parseTooltipDetailsInPage = value => {
        const text = stripMarkupInPage(value);
        const details = {};
        const fields = {
          counter: /(?:^|\n)\s*Counter\s*:\s*([^\n]+)/i,
          action: /(?:^|\n)\s*Action\s*:\s*([^\n]+)/i,
          hardware: /(?:^|\n)\s*Hardware\s*:\s*([^\n]+)/i,
          scenario: /(?:^|\n)\s*Scenario\s*:\s*([^\n]+)/i,
          rawData: /(?:^|\n)\s*Raw\s*data\s*:\s*([^\n]+)/i,
          processor: /(?:^|\n)\s*Processor\s*:\s*([^\n]+)/i
        };
        for (const [field, pattern] of Object.entries(fields)) {
          const match = text.match(pattern);
          if (match) details[field] = match[1].trim();
        }
        return details;
      };

      const charts = Array.isArray(window.__enduranceCanvasJSCharts) ? window.__enduranceCanvasJSCharts : [];
      const series = [];
      const toNumber = value => {
        if (value == null) return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const extractSeries = (dataSeries, seriesIndex) => {
        const points = Array.isArray(dataSeries?.dataPoints) ? dataSeries.dataPoints : [];
        const validPoints = points.filter(point => Number.isFinite(toNumber(point?.y)));
        const values = validPoints.map(point => toNumber(point.y));
        if (values.length < 2) return;
        const firstPoint = validPoints[0] || {};
        const lastPoint = validPoints[validPoints.length - 1] || {};
        const tooltipTemplate = firstDefinedInPage(dataSeries.toolTipContent, dataSeries.tooltipContent, firstPoint.toolTipContent, lastPoint.toolTipContent, '');
        const replaceTokens = (template, point) => String(template || '').replace(/\{([^}]+)\}/g, (_match, key) => firstDefinedInPage(point[key], dataSeries[key], ''));
        const tooltipDetails = parseTooltipDetailsInPage(replaceTokens(tooltipTemplate, lastPoint));
        const name = firstDefinedInPage(dataSeries.name, dataSeries.legendText, dataSeries.label, tooltipDetails.processor, `Process ${seriesIndex + 1}`);
        const metadata = {
          counter: firstDefinedInPage(lastPoint.counter, lastPoint.Counter, dataSeries.counter, tooltipDetails.counter),
          action: firstDefinedInPage(lastPoint.action, lastPoint.Action, dataSeries.action, tooltipDetails.action),
          hardware: firstDefinedInPage(lastPoint.hardware, lastPoint.Hardware, dataSeries.hardware, tooltipDetails.hardware),
          scenario: firstDefinedInPage(lastPoint.scenario, lastPoint.Scenario, dataSeries.scenario, tooltipDetails.scenario),
          rawData: firstDefinedInPage(lastPoint.rawData, lastPoint.RawData, lastPoint.raw, tooltipDetails.rawData),
          processor: firstDefinedInPage(lastPoint.processor, lastPoint.Processor, dataSeries.processor, tooltipDetails.processor)
        };
        series.push({ name: String(name), values, metadata });
      };
      charts.forEach(chart => {
        const data = chart?.options?.data || chart?._options?.data || [];
        if (Array.isArray(data)) data.forEach(extractSeries);
      });
      return {
        source: 'CanvasJS',
        series,
        diagnostics: {
          registeredCharts: charts.length,
          canvases: document.querySelectorAll('canvas').length,
          canvasJSAvailable: typeof window.CanvasJS !== 'undefined'
        }
      };
    });
    diagnostics = result.diagnostics;
    if (result.series.length) return result;
    await page.waitForTimeout(250);
  }
  return { source: 'CanvasJS', series: [], diagnostics };
}

function determineUnit(seriesList) {
  const values = seriesList.flatMap(series => series.values).filter(Number.isFinite);
  const maxValue = values.length ? Math.max(...values.map(Math.abs)) : 0;
  return maxValue >= BYTES_PER_MB ? 'bytes' : 'MB';
}
function valueToMB(value, unit) { return unit === 'bytes' ? value / BYTES_PER_MB : value; }
function stripMarkup(value) {
  return String(value || '')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}
function parseTooltipDetails(value) {
  const text = stripMarkup(value);
  const details = {};
  const fields = {
    counter: /(?:^|\n)\s*Counter\s*:\s*([^\n]+)/i,
    action: /(?:^|\n)\s*Action\s*:\s*([^\n]+)/i,
    hardware: /(?:^|\n)\s*Hardware\s*:\s*([^\n]+)/i,
    scenario: /(?:^|\n)\s*Scenario\s*:\s*([^\n]+)/i,
    rawData: /(?:^|\n)\s*Raw\s*data\s*:\s*([^\n]+)/i,
    processor: /(?:^|\n)\s*Processor\s*:\s*([^\n]+)/i
  };
  for (const [field, pattern] of Object.entries(fields)) {
    const match = text.match(pattern);
    if (match) details[field] = match[1].trim();
  }
  return details;
}
function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && String(value).trim() !== '');
}
function classifyMemoryBehavior(valuesMB) {
  const values = valuesMB.filter(Number.isFinite);
  if (values.length < 3) return { behavior: 'INSUFFICIENT DATA', confidence: 'Low', peakMB: values.length ? Math.max(...values) : 0, minimumMB: values.length ? Math.min(...values) : 0, largestIncreaseMB: 0, largestReleaseMB: 0, risingRatio: 0, finalToPeakRatio: 0 };
  const initial = values[0];
  const final = values[values.length - 1];
  const peak = Math.max(...values);
  const minimum = Math.min(...values);
  const deltas = values.slice(1).map((value, index) => value - values[index]);
  const tolerance = Math.max(1, Math.abs(initial) * 0.01);
  const rising = deltas.filter(delta => delta > tolerance).length;
  const falling = deltas.filter(delta => delta < -tolerance).length;
  const largestIncrease = Math.max(0, ...deltas);
  const largestRelease = Math.abs(Math.min(0, ...deltas));
  const risingRatio = deltas.length ? rising / deltas.length : 0;
  const finalToPeakRatio = peak > 0 ? final / peak : 0;
  const peakGrowth = peak - initial;
  const netGrowth = final - initial;
  const recovered = peak - final;
  const recoveryRatio = peakGrowth > 0 ? recovered / peakGrowth : 0;
  let behavior = 'STABLE VARIATION';
  let confidence = 'Medium';
  if (peakGrowth > 100 && recoveryRatio >= 0.60) {
    behavior = peak > final * 1.5 ? 'SPIKE WITH RECOVERY' : 'TEMPORARY ALLOCATION';
    confidence = 'High';
  } else if (netGrowth > 100 && finalToPeakRatio >= 0.90 && risingRatio >= 0.70) {
    behavior = 'CONTINUOUS GROWTH';
    confidence = 'High';
  } else if (netGrowth > 100 && finalToPeakRatio >= 0.85 && largestIncrease > Math.max(25, netGrowth * 0.20)) {
    behavior = 'STEP GROWTH';
    confidence = 'Medium';
  } else if (netGrowth > 100 && finalToPeakRatio >= 0.85) {
    behavior = 'SUSTAINED GROWTH';
    confidence = 'Medium';
  } else if (falling > 0 && rising > 0) {
    behavior = 'STABLE VARIATION';
    confidence = 'Medium';
  }
  return {
    behavior,
    confidence,
    peakMB: Number(peak.toFixed(2)),
    minimumMB: Number(minimum.toFixed(2)),
    largestIncreaseMB: Number(largestIncrease.toFixed(2)),
    largestReleaseMB: Number(largestRelease.toFixed(2)),
    risingRatio: Number((risingRatio * 100).toFixed(1)),
    finalToPeakRatio: Number((finalToPeakRatio * 100).toFixed(1))
  };
}

function parseProcessAndPid(seriesName) {
  const rawSeriesName = String(seriesName || '').replace(/\s+/g, ' ').trim();
  const patterns = [
    /^(.*?)\s*-\s*PID\s*:\s*(\d+)\s*$/i,
    /^(.*?)\s*\(\s*PID\s*[:#]?\s*(\d+)\s*\)\s*$/i,
    /^(.*?)\s*[-|]\s*PID\s*[#:]?\s*(\d+)\b/i,
    /^(.*?)\s+PID\s*[#:]?\s*(\d+)\b/i
  ];
  for (const pattern of patterns) {
    const match = rawSeriesName.match(pattern);
    if (match) return { processName: match[1].trim(), pid: match[2], rawSeriesName };
  }
  return { processName: rawSeriesName || 'Unknown process', pid: null, rawSeriesName };
}
async function analyzePrivateBytes(page, combination, tabId) {
  const extracted = await extractCanvasJsSeries(page);
  if (!extracted.series.length) {
    const details = extracted.diagnostics || {};
    return {
      status: 'NOT_ANALYZED', tabId, results: [], source: extracted.source,
      reason: `CanvasJS detected, but no series with at least two numeric points was captured. Charts=${details.registeredCharts ?? 0}, Canvas=${details.canvases ?? 0}.`
    };
  }
  const unit = determineUnit(extracted.series);
  const results = extracted.series.map(series => {
    const initialMB = valueToMB(series.values[0], unit);
    const finalMB = valueToMB(series.values[series.values.length - 1], unit);
    const increaseMB = finalMB - initialMB;
    const metadataProcess = parseProcessAndPid(series.metadata?.processor || series.name);
    const processInfo = metadataProcess.pid || metadataProcess.processName !== 'Unknown process' ? metadataProcess : parseProcessAndPid(series.name);
    const behavior = classifyMemoryBehavior(series.values.map(value => valueToMB(value, unit)));
    return {
      tabId,
      hardware: combination.hardware,
      action: combination.action,
      counter: combination.counter,
      process: processInfo.processName,
      pid: processInfo.pid,
      rawSeriesName: processInfo.rawSeriesName,
      scenario: series.metadata?.scenario || 'Not available',
      graphAction: series.metadata?.action || combination.action,
      graphHardware: series.metadata?.hardware || combination.hardware,
      graphCounter: series.metadata?.counter || 'Private Bytes',
      rawData: series.metadata?.rawData || `${Number(finalMB.toFixed(3))} MB`,
      behavior: behavior.behavior,
      behaviorConfidence: behavior.confidence,
      peakMB: behavior.peakMB,
      minimumMB: behavior.minimumMB,
      largestIncreaseMB: behavior.largestIncreaseMB,
      largestReleaseMB: behavior.largestReleaseMB,
      risingRatio: behavior.risingRatio,
      finalToPeakRatio: behavior.finalToPeakRatio,
      chartName: buildChartName(combination.hardware, combination.action, processInfo.processName, combination.counter),
      initialMB: Number(initialMB.toFixed(2)),
      finalMB: Number(finalMB.toFixed(2)),
      increaseMB: Number(increaseMB.toFixed(2)),
      severity: classifyIncrease(increaseMB),
      source: extracted.source,
      detectedUnit: unit
    };
  });
  return { status: 'ANALYZED', tabId, source: extracted.source, unit, results };
}

function buildTabTitle(hardware, action, counter) { return `${hardware} | ${action} | ${counter}`.replace(/\s+/g, ' ').trim(); }
async function configureTab(page, combination, tabId) {
  const { hardware, action, counter } = combination;
  const title = buildTabTitle(hardware, action, counter);
  console.log(`\nConfigurando aba: ${title}`);
  try {
    await waitForReport(page);
    await clearInitialSelections(page);
    const hardwareOk = await clickExactCheckbox(page, '#tableHardware', hardware, 'Hardware');
    await page.waitForTimeout(WAIT_AFTER_HARDWARE_MS);
    const actionOk = await clickExactCheckbox(page, '#tableActions', action, 'Action');
    const counterOk = actionOk ? await selectExactCounter(page, counter) : false;
    await page.evaluate(newTitle => { document.title = newTitle; }, title);
    if (!(hardwareOk && actionOk && counterOk)) return { success: false, analysis: null };
    if (!isPrivateBytes(counter)) return { success: true, analysis: null };
    return { success: true, analysis: await analyzePrivateBytes(page, combination, tabId) };
  } catch (error) {
    console.log(`  [ERRO] ${error.message}`);
    return { success: false, analysis: null, error: error.message };
  }
}

function findInstalledBrowser() {
  const candidates = [
    process.env.ENDURANCE_BROWSER_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

(async () => {
  let context;
  let closing = false;
  const pageByTabId = new Map();
  try {
    sendUiEvent('status', { phase: 'opening', title: 'Opening performance report', description: 'Starting browser and loading report.' });
    const profilePath = process.env.ENDURANCE_PROFILE_PATH || path.join(os.tmpdir(), 'EnduranceAutomation', 'browser-profile');
    fs.mkdirSync(profilePath, { recursive: true });
    const executablePath = findInstalledBrowser();
    if (!executablePath) throw new Error('Microsoft Edge or Google Chrome was not found.');
    context = await chromium.launchPersistentContext(profilePath, { executablePath, headless: false, viewport: null, args: ['--start-maximized', '--disable-popup-blocking'] });
    const firstPage = context.pages()[0] || await context.newPage();
    await waitForReport(firstPage);

    sendUiEvent('status', { phase: 'discovery', title: 'Discovering report data', description: 'Reading KVS, POS and available actions.' });
    const hardwareValues = await readInitialValues(firstPage, '#tableHardware');
    const actionValues = await readInitialValues(firstPage, '#tableActions');
    const kvsHardwares = unique(hardwareValues.filter(value => /\bKVS\d+/i.test(String(value || ''))));
    const posHardwares = unique(hardwareValues.filter(value => normalize(value).startsWith('POS')));
    const actions = unique(actionValues);
    const serveOrder = actions.find(action => normalize(action) === 'SERVE ORDER');
    const posActions = actions.filter(action => normalize(action) !== 'SERVE ORDER');
    sendUiEvent('discovery', { kvs: kvsHardwares.length, pos: posHardwares.length, actions: actions.length, posActions: posActions.length, counters: TARGET_COUNTERS.length });

    const combinations = [];
    if (serveOrder) for (const hardware of kvsHardwares) for (const counter of TARGET_COUNTERS) combinations.push({ hardware, action: serveOrder, counter });
    for (const hardware of posHardwares) for (const action of posActions) for (const counter of TARGET_COUNTERS) combinations.push({ hardware, action, counter });
    sendUiEvent('plan', { total: combinations.length });
    sendUiEvent('status', { phase: 'execution', title: 'Analyzing report charts', description: 'Preparing views and evaluating CanvasJS Private Bytes data.' });

    let successCount = 0;
    let warningCount = 0;
    const totals = { HIGH: 0, MEDIUM: 0, LOW: 0, NOT_ANALYZED: 0 };
    let preferredPage = null;

    for (let index = 0; index < combinations.length; index++) {
      const combination = combinations[index];
      const tabId = buildTabId(index);
      const page = index === 0 ? firstPage : await context.newPage();
      pageByTabId.set(tabId, page);
      sendUiEvent('current', { index: index + 1, total: combinations.length, ...combination });
      const outcome = await configureTab(page, combination, tabId);
      outcome.success ? successCount++ : warningCount++;

      if (outcome.analysis?.status === 'ANALYZED') {
        outcome.analysis.results.forEach(result => totals[result.severity]++);
        sendUiEvent('memory-analysis', { tabId, results: outcome.analysis.results, source: outcome.analysis.source });
        const hasHigh = outcome.analysis.results.some(result => result.severity === 'HIGH');
        const hasMedium = outcome.analysis.results.some(result => result.severity === 'MEDIUM');
        if (hasHigh && !preferredPage) preferredPage = page;
        else if (hasMedium && !preferredPage) preferredPage = page;
        if (!hasHigh && !hasMedium) { await page.close(); pageByTabId.delete(tabId); }
      } else if (outcome.analysis?.status === 'NOT_ANALYZED') {
        totals.NOT_ANALYZED++;
        warningCount++;
        sendUiEvent('analysis-warning', { tabId, ...combination, reason: outcome.analysis.reason });
      } else if (!isPrivateBytes(combination.counter) && outcome.success) {
        await page.close();
        pageByTabId.delete(tabId);
      }
      sendUiEvent('progress', { completed: index + 1, total: combinations.length, success: successCount, warnings: warningCount, severityTotals: totals });
    }

    if (preferredPage && !preferredPage.isClosed()) await preferredPage.bringToFront();
    sendUiEvent('completed', { total: combinations.length, success: successCount, warnings: warningCount, openTabs: context.pages().filter(page => !page.isClosed()).length, severityTotals: totals });

    process.on('message', async message => {
      if (message?.type !== 'focus-chart') return;
      const page = pageByTabId.get(message.tabId);
      if (page && !page.isClosed()) await page.bringToFront().catch(() => {});
    });
    const closeEverything = async () => {
      if (closing) return;
      closing = true;
      try { await context.close(); } finally { process.exit(0); }
    };
    process.on('SIGINT', closeEverything);
    process.on('SIGTERM', closeEverything);
    await new Promise(() => {});
  } catch (error) {
    console.error(error);
    sendUiEvent('error', { message: error?.message || String(error) });
    if (context) {
      process.on('SIGINT', async () => { if (!closing) { closing = true; await context.close(); process.exit(1); } });
      await new Promise(() => {});
    } else {
      process.exit(1);
    }
  }
})();
