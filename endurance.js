const { chromium } = require('playwright');
const path = require('path');

/*
  ENDURANCE REPORT AUTOMATION

  Fluxo:
  1. Identifica Hardwares e Actions.
  2. Cria uma aba para cada Hardware + Action + Counter.
  3. Seleciona Hardware e Action.
  4. Aguarda a tabela dinamica #tableCounters ser carregada.
  5. Clica EXATAMENTE em:
       - Process - Handle Count
       - Process - Private Bytes
  6. Mantem todas as abas abertas ate Ctrl+C.
*/

const REPORT_URL = process.argv[2];


const TARGET_COUNTERS = [
  'Process - Handle Count',
  'Process - Private Bytes'
];

const WAIT_AFTER_PAGE_LOAD_MS = 1000;
const WAIT_AFTER_HARDWARE_MS = 300;
const COUNTER_TIMEOUT_MS = 30000;
const WAIT_AFTER_COUNTER_MS = 1500;

if (!REPORT_URL) {
  console.error(`
URL do report nao informada.

Uso:
  node endurance.js "<URL_DO_REPORT>"

Exemplo:
  node endurance.js "https://servidor/GraphicCharts/PivotGraph/id"
`);
  process.exit(1);
}

function normalize(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function unique(values) {
  return [...new Set(values)];
}

async function waitForReport(page) {
  await page.goto(REPORT_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.locator('#tableHardware input[type="checkbox"]').first().waitFor({
    state: 'attached',
    timeout: 30000
  });

  await page.locator('#tableActions input[type="checkbox"]').first().waitFor({
    state: 'attached',
    timeout: 30000
  });

  await page.waitForTimeout(WAIT_AFTER_PAGE_LOAD_MS);
}

async function readInitialValues(page, tableSelector) {
  return page
    .locator(`${tableSelector} input[type="checkbox"]`)
    .evaluateAll((elements) =>
      elements.map((element) => element.value).filter(Boolean)
    );
}

async function findExactCheckbox(page, tableSelector, expectedValue) {
  const checkboxes = page.locator(
    `${tableSelector} input[type="checkbox"]`
  );

  const count = await checkboxes.count();

  for (let index = 0; index < count; index++) {
    const checkbox = checkboxes.nth(index);
    const actualValue = await checkbox.getAttribute('value');

    if (actualValue === expectedValue) {
      return checkbox;
    }
  }

  return null;
}

async function clickExactCheckbox(
  page,
  tableSelector,
  value,
  roleName
) {
  const checkbox = await findExactCheckbox(
    page,
    tableSelector,
    value
  );

  if (!checkbox) {
    console.log(`  [ERRO] ${roleName} nao encontrado: ${value}`);
    return false;
  }

  await checkbox.scrollIntoViewIfNeeded();

  if (!(await checkbox.isChecked())) {
    await checkbox.click();
  }

  return true;
}

async function clearInitialSelections(page) {
  const checked = page.locator(
    '#tableHardware input[type="checkbox"]:checked, ' +
    '#tableActions input[type="checkbox"]:checked'
  );

  let safetyCounter = 0;

  while ((await checked.count()) > 0 && safetyCounter < 100) {
    await checked.first().click();
    await page.waitForTimeout(50);
    safetyCounter++;
  }
}

async function waitForExactCounter(page, counterName) {
  const deadline = Date.now() + COUNTER_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const counter = await findExactCheckbox(
      page,
      '#tableCounters',
      counterName
    );

    if (counter) {
      const visible = await counter.isVisible().catch(() => false);
      const enabled = await counter.isEnabled().catch(() => false);

      if (visible && enabled) {
        return counter;
      }
    }

    await page.waitForTimeout(250);
  }

  return null;
}

async function selectExactCounter(page, counterName) {
  const counter = await waitForExactCounter(page, counterName);

  if (!counter) {
    const availableCounters = await page
      .locator('#tableCounters input[type="checkbox"]')
      .evaluateAll((elements) =>
        elements.map((element) => element.value).filter(Boolean)
      )
      .catch(() => []);

    console.log(`  [ERRO] Counter exato nao encontrado: ${counterName}`);
    console.log('  Counters disponiveis nesta aba:');

    if (availableCounters.length === 0) {
      console.log('    Nenhum counter foi carregado.');
    } else {
      availableCounters.forEach((value) =>
        console.log(`    - ${value}`)
      );
    }

    return false;
  }

  await counter.scrollIntoViewIfNeeded();

  if (!(await counter.isChecked())) {
    await counter.click();
  }

  await page.waitForTimeout(WAIT_AFTER_COUNTER_MS);
  return true;
}

function buildTabTitle(hardware, action, counter) {
  return `${hardware} | ${action} | ${counter}`
    .replace(/\s+/g, ' ')
    .trim();
}

async function configureTab(page, combination) {
  const { hardware, action, counter } = combination;
  const title = buildTabTitle(hardware, action, counter);

  console.log(`\nConfigurando aba: ${title}`);

  try {
    await waitForReport(page);
    await clearInitialSelections(page);

    const hardwareOk = await clickExactCheckbox(
      page,
      '#tableHardware',
      hardware,
      'Hardware'
    );

    await page.waitForTimeout(WAIT_AFTER_HARDWARE_MS);

    const actionOk = await clickExactCheckbox(
      page,
      '#tableActions',
      action,
      'Action'
    );

    /*
      LoadDivCounters() e chamado pela pagina depois que Hardware e Action
      estao selecionados. Aqui aguardamos o checkbox exato ser inserido em
      #tableCounters antes de clicar.
    */
    const counterOk = actionOk
      ? await selectExactCounter(page, counter)
      : false;

    await page.evaluate((newTitle) => {
      document.title = newTitle;
    }, title);

    if (hardwareOk && actionOk && counterOk) {
      console.log('  [OK] Aba configurada com o counter correto.');
      return true;
    }

    console.log('  [AVISO] Aba mantida aberta para verificacao.');
    return false;
  } catch (error) {
    console.log(`  [ERRO] ${error.message}`);
    console.log('  [AVISO] Aba mantida aberta para verificacao.');
    return false;
  }
}

(async () => {
  let context;
  let closing = false;

  try {
    console.log('');
    console.log('================================================');
    console.log(' ENDURANCE AUTOMATION - COUNTER EXATO');
    console.log('================================================');
    console.log(`Report: ${REPORT_URL}`);
    console.log('');

    const profilePath = path.join(
      __dirname,
      '.endurance-playwright-profile'
    );

    context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      viewport: null,
      args: [
        '--start-maximized',
        '--disable-popup-blocking'
      ]
    });

    const existingPages = context.pages();
    const firstPage = existingPages.length > 0
      ? existingPages[0]
      : await context.newPage();

    console.log('Lendo Hardwares e Actions...');
    await waitForReport(firstPage);

    const hardwareValues = await readInitialValues(
      firstPage,
      '#tableHardware'
    );

    const actionValues = await readInitialValues(
      firstPage,
      '#tableActions'
    );

    const kvsHardwares = unique(
      hardwareValues.filter((value) =>
        normalize(value).startsWith('KVS')
      )
    );

    const posHardwares = unique(
      hardwareValues.filter((value) =>
        normalize(value).startsWith('POS')
      )
    );

    const actions = unique(actionValues);

    const serveOrder = actions.find(
      (action) => normalize(action) === 'SERVE ORDER'
    );

    console.log(`KVS encontrados: ${kvsHardwares.length}`);
    console.log(`POS encontrados: ${posHardwares.length}`);
    console.log(`Actions encontradas: ${actions.length}`);
    console.log(`Counters planejados: ${TARGET_COUNTERS.length}`);

    const combinations = [];

    if (serveOrder) {
      for (const hardware of kvsHardwares) {
        for (const counter of TARGET_COUNTERS) {
          combinations.push({
            hardware,
            action: serveOrder,
            counter
          });
        }
      }
    } else if (kvsHardwares.length > 0) {
      console.log('[AVISO] Action Serve Order nao encontrada.');
    }

    for (const hardware of posHardwares) {
      for (const action of actions) {
        for (const counter of TARGET_COUNTERS) {
          combinations.push({ hardware, action, counter });
        }
      }
    }

    console.log(`Total de combinacoes: ${combinations.length}`);

    let successCount = 0;
    let warningCount = 0;

    for (let index = 0; index < combinations.length; index++) {
      const page = index === 0
        ? firstPage
        : await context.newPage();

      const success = await configureTab(
        page,
        combinations[index]
      );

      success ? successCount++ : warningCount++;
    }

    console.log('');
    console.log('================================================');
    console.log(' AUTOMACAO CONCLUIDA');
    console.log('================================================');
    console.log(`Abas configuradas: ${successCount}`);
    console.log(`Abas com aviso: ${warningCount}`);
    console.log(`Total de abas abertas: ${context.pages().length}`);
    console.log('');
    console.log('As abas permanecerao abertas na mesma janela.');
    console.log('Para fechar tudo, pressione Ctrl+C no terminal.');
    console.log('');

    const closeEverything = async () => {
      if (closing) return;
      closing = true;

      console.log('\nFechando navegador e abas...');

      try {
        await context.close();
      } finally {
        process.exit(0);
      }
    };

    process.on('SIGINT', closeEverything);
    process.on('SIGTERM', closeEverything);

    await new Promise(() => {});
  } catch (error) {
    console.error('\nERRO NA AUTOMACAO:');
    console.error(error);

    if (context) {
      console.log('\nA janela permanecera aberta para verificacao.');
      console.log('Pressione Ctrl+C para fechar.');

      process.on('SIGINT', async () => {
        if (closing) return;
        closing = true;
        await context.close();
        process.exit(1);
      });

      await new Promise(() => {});
    } else {
      process.exit(1);
    }
  }
})();
