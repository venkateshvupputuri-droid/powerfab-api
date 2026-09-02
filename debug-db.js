const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({host:'127.0.0.1', port:3306, user:'admin', password:'fab', database:'fabrication'});
  const sqls = [
    ['SELECT * FROM `productioncontrolassemblies` WHERE `ProductionControlID` = ? ORDER BY `ProductionControlAssemblyID` LIMIT 10', [7]],
    ['SELECT COUNT(*) AS total FROM `productioncontrolassemblies` WHERE `ProductionControlID` = ?', [7]],
    ['SELECT `ProductionControlAssemblyID`, MIN(`MainMark`) AS main_mark, MIN(`DrawingNumber`) AS drawing_no, SUM(`Quantity`) AS assy_qty, SUM(`Weight` * `Quantity`) AS weight_total FROM `productioncontrolitems` WHERE `ProductionControlID` = ? GROUP BY `ProductionControlAssemblyID` ORDER BY `ProductionControlAssemblyID` LIMIT 10', [7]]
  ];
  for (const [sql, params] of sqls) {
    const [rows] = await conn.query(sql, params);
    console.log('\nSQL:', sql);
    console.log(JSON.stringify(rows, null, 2));
  }
  await conn.end();
})();
