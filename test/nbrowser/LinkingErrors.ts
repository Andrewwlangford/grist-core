/**
 * Test various error situations with linking page widgets.
 */
import {assert, driver, stackWrapFunc} from 'mocha-webdriver';
import * as gu from 'test/nbrowser/gristUtils';
import {setupTestSuite} from 'test/nbrowser/testUtils';

import {toTableDataAction} from 'app/common/DocActions';
import {schema} from 'app/common/schema';
import {TableData} from 'app/common/TableData';
import {DocAPI, UserAPI} from 'app/common/UserAPI';

describe("LinkingErrors", function() {
  this.timeout(20000);
  const cleanup = setupTestSuite();
  let session: gu.Session;
  let api: UserAPI;
  let docId: string;

  afterEach(() => gu.checkForErrors());

  it("should link correctly in the normal case", async function() {
    session = await gu.session().teamSite.login();
    api = session.createHomeApi();
    docId = await session.tempNewDoc(cleanup, 'LinkingErrors1', {load: false});

    // Make a table with some data.
    await api.applyUserActions(docId, [
      ['AddTable', 'Planets', [{id: 'PlanetName'}]],
      // Negative IDs allow referrnig to added records in the same action bundle.
      ['AddRecord', 'Planets', -1, {PlanetName: 'Earth'}],
      ['AddRecord', 'Planets', -2, {PlanetName: 'Mars'}],
      ['AddTable', 'Moons', [{id: 'MoonName'}, {id: 'Planet', type: 'Ref:Planets'}]],
      ['AddRecord', 'Moons', null, {MoonName: 'Phobos', Planet: -2}],
      ['AddRecord', 'Moons', null, {MoonName: 'Deimos', Planet: -2}],
      ['AddRecord', 'Moons', null, {MoonName: 'Moon', Planet: -1}],
    ]);

    // Load the document.
    await session.loadDoc(`/doc/${docId}`);

    await gu.getPageItem('Planets').click();
    await gu.waitForDocToLoad();
    await gu.addNewSection(/Table/, /Moons/, {selectBy: /PLANETS/});

    await checkLinking();
  });

  // Check that normal linking works.
  const checkLinking = stackWrapFunc(async function() {
    await gu.getCell({section: 'PLANETS', rowNum: 1, col: 'PlanetName'}).click();
    assert.deepEqual(await gu.getVisibleGridCells({section: 'MOONS', col: 'MoonName', rowNums: [1, 2]}),
      ['Moon', '']);
    await gu.getCell({section: 'PLANETS', rowNum: 2, col: 'PlanetName'}).click();
    assert.deepEqual(await gu.getVisibleGridCells({section: 'MOONS', col: 'MoonName', rowNums: [1, 2, 3]}),
      ['Phobos', 'Deimos', '']);
  });

  it("should unset linking setting when changing the data table for a widget", async function() {
    await gu.getCell({section: 'Moons', rowNum: 1, col: 'MoonName'}).click();
    await gu.toggleSidePanel('right', 'open');
    await driver.find('.test-right-tab-pagewidget').click();
    await driver.findContent('.test-right-panel button', /Change Widget/).click();

    assert.equal(await driver.find('.test-wselect-table-label[class*=-selected]').getText(), 'Moons');
    await driver.findContent('.test-wselect-table', /Planets/).click();
    assert.match(await driver.find('.test-wselect-selectby').value(), /Select Widget/);

    await driver.find('.test-wselect-addBtn').doClick();
    await gu.waitForServer();

    // Check that the two sections on the page are now for the same table, and link settings are
    // cleared.
    const tables = await getTableData(api.getDocAPI(docId), '_grist_Tables');
    const sections = await getTableData(api.getDocAPI(docId), '_grist_Views_section');
    const planetsTable = tables.filterRecords({tableId: 'Planets'})[0];
    assert.isOk(planetsTable);
    const planetsSections = sections.filterRecords({tableRef: planetsTable.id});
    assert.lengthOf(planetsSections, 3);
    assert.equal(planetsSections[0].parentId, planetsSections[2].parentId);
    assert.deepEqual(planetsSections.map(s => s.linkTargetColRef), [0, 0, 0]);
    assert.deepEqual(planetsSections.map(s => s.linkSrcSectionRef), [0, 0, 0]);
    assert.deepEqual(planetsSections.map(s => s.linkSrcColRef), [0, 0, 0]);

    // Switch to another page and back and check that there are no errors.
    await gu.getPageItem('Moons').click();
    await gu.checkForErrors();
    await gu.getPageItem('Planets').click();
    await gu.checkForErrors();

    // Now undo.
    await gu.undo();

    // Still should have no errors, and linking should be restored.
    await gu.checkForErrors();
    await checkLinking();
  });

  it("should fail to link gracefully when linking settings are wrong", async function() {
    // Fetch link settings, then mess them up.
    const columns = await getTableData(api.getDocAPI(docId), '_grist_Tables_column');
    const sections = await getTableData(api.getDocAPI(docId), '_grist_Views_section');
    const planetRefCol = columns.filterRecords({colId: 'Planet'})[0];       // In table Moons
    const planetNameCol = columns.filterRecords({colId: 'PlanetName'})[0];  // In table Planets
    assert.isOk(planetRefCol);
    assert.isOk(planetNameCol);
    const planetSec = sections.filterRecords({linkTargetColRef: planetRefCol.id})[0];
    assert.isOk(planetSec);

    // Set invalid linking. The column we are setting is for the wrong table. It used to happen
    // occasionally due to other bugs, here we check that we ignore such invalid settings.
    await api.applyUserActions(docId, [
      ['UpdateRecord', '_grist_Views_section', planetSec.id, {linkTargetColRef: planetNameCol.id}]
    ]);

    // Reload the page.
    await driver.navigate().refresh();
    await gu.waitForDocToLoad();

    // Expect no errors, and expect to see data, although it's no longer linked.
    await gu.checkForErrors();
    await gu.getCell({section: 'PLANETS', rowNum: 1, col: 'PlanetName'}).click();
    assert.deepEqual(await gu.getVisibleGridCells({section: 'MOONS', col: 'MoonName', rowNums: [1, 2, 3, 4]}),
      ['Phobos', 'Deimos', 'Moon', '']);

    // Reverting to correct settings should make the data linked again.
    await api.applyUserActions(docId, [
      ['UpdateRecord', '_grist_Views_section', planetSec?.id, {linkTargetColRef: planetRefCol.id}]
    ]);
    await gu.checkForErrors();
    await checkLinking();
  });

  it("should recreate page with undo", async function() {
    const tempDoc = await session.tempNewDoc(cleanup, 'LinkingErrors2', {load: false});
    // This tests the bug: When removing page with linked sections and then undoing, there are two JS errors raised:
    // - flexSize is not a function
    // - getter is not a function

    // To recreate create a simple document:
    // - Table1 with default columns
    // - Table2 with A being reference to Table1
    // - For Table1 page add:
    // -- Single card view selected by Table1
    // -- Table2 view selected by Table1
    // And make some updates that will cause a bug (without it undoing works).
    // Modify the layout for page Table1, this makes the first JS bug (flexSize ...) when undoing.
    // And add some records, which makes the second JS bug (getter is not a function).
    const actions = [
      ['CreateViewSection', 1, 1, 'single', null, null],
      ['AddEmptyTable', null],
      ['UpdateRecord', '_grist_Tables_column', 6, {type: 'Ref:Table1'}],
      ['CreateViewSection', 2, 1, 'record', null, null],
      ['UpdateRecord', '_grist_Views_section', 3, {linkSrcSectionRef: 1, linkSrcColRef: 0, linkTargetColRef: 0}],
      ['UpdateRecord', '_grist_Views_section', 6, {linkSrcSectionRef: 1, linkSrcColRef: 0, linkTargetColRef: 6}],
      [
        'UpdateRecord',
        '_grist_Views',
        1,
        {layoutSpec: '{"children":[{"children":[{"leaf":1},{"children":[{"leaf":2},{"leaf":4}]}]}]}'},
      ],
      ['AddRecord', 'Table1', null, {A: '1'}],
      ['AddRecord', 'Table2', null, {A: 1, B: '2'}],
    ];
    await api.applyUserActions(tempDoc, actions);
    // Load the document.
    await session.loadDoc(`/doc/${tempDoc}`);
    const revert = await gu.begin();
    // Remove the first page (and Table1).
    await gu.removePage('Table1', {withData: true});
    await gu.waitForServer();
    // And do undo
    await revert();
    await gu.checkForErrors();
  });
});

async function getTableData(docApi: DocAPI, tableId: string): Promise<TableData> {
  const colValues = await docApi.getRows(tableId);
  const tableAction = toTableDataAction(tableId, colValues);
  return new TableData(tableId, tableAction, (schema as any)[tableId]);
}
