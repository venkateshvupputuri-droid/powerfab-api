import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { PrismaClient, FabricationStatus } from '@prisma/client';
import QRCode from 'qrcode';
import { z } from 'zod';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { createPool } from 'mysql2/promise';
import { existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { deleteContractorSession, loadContractorSessions, upsertContractorSession } from './sessionStore';

const prisma = new PrismaClient();
const app = express();
const port = Number(process.env.PORT ?? 3000);
const publicAppUrl = process.env.PUBLIC_APP_URL ?? `http://localhost:${port}`;
const powerFabDrawingsUrlTemplate = process.env.POWERFAB_DRAWINGS_URL_TEMPLATE ?? 'https://adani.teklapowerfab.net/pdc-job-overview?ProductionControlID={productionControlId}#sectionDrawings';
const drawingsRoot = process.env.POWERFAB_DRAWINGS_ROOT ?? '';
const contractorSessionStoreFile = process.env.CONTRACTOR_SESSION_FILE ?? resolve(process.cwd(), 'data', 'contractor-sessions.json');
const contractorSessions = loadContractorSessions(contractorSessionStoreFile);

function findDrawingPdf(root: string, fileName: string): string | null {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return resolve(entryPath);
    if (entry.isDirectory()) {
      const match = findDrawingPdf(entryPath, fileName);
      if (match) return match;
    }

  }
  return null;
}
const projectTableCandidates = (process.env.POWERFAB_PROJECT_TABLES ?? 'projects,productioncontroljobs,externalprojects').split(',').map((value) => value.trim()).filter(Boolean);
const projectJobColumn = process.env.POWERFAB_JOB_COLUMN ?? 'JobNumber';
const projectDescriptionColumn = process.env.POWERFAB_DESCRIPTION_COLUMN ?? 'JobDescription';
const projectSiteColumn = process.env.POWERFAB_SITE_COLUMN ?? 'JobLocation';
const projectPlantColumn = process.env.POWERFAB_PLANT_COLUMN ?? 'GroupName';
const projectUnitColumn = process.env.POWERFAB_UNIT_COLUMN ?? 'GroupName2';
const projectLocationColumn = process.env.POWERFAB_LOCATION_COLUMN ?? 'JobLocation';
const projectStatusColumn = process.env.POWERFAB_STATUS_COLUMN ?? 'JobStatusID';
const projectUpdatedAtColumn = process.env.POWERFAB_UPDATED_AT_COLUMN ?? 'JobDate';

const mysqlUrl = process.env.DATABASE_URL ?? 'mysql://admin:fab@127.0.0.1:3306/fabrication';
const mysqlConnection = (() => {
  const url = new URL(mysqlUrl);
  return createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: url.username || 'admin',
    password: url.password || 'fab',
    database: url.pathname.replace(/^\/+/, ''),
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
  });
})();

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.get('/mobile', (_request, response) => response.redirect('/scan.html'));
app.use(express.static('public'));

const statuses = Object.values(FabricationStatus);
const fabricationStages = ['Fitup', 'Inspection', 'Shifting to Paint', 'Painting', 'Laydown', 'Shifting to Site'] as const;
const fabricationStageSchema = z.enum(fabricationStages);
const assemblyStatusStore = new Map<string, { currentStage: (typeof fabricationStages)[number]; history: Array<{ stage: (typeof fabricationStages)[number]; updatedAt: string }> }>();

async function ensureAssemblyScanTables() {
  await mysqlConnection.query(`
    CREATE TABLE IF NOT EXISTS assembly_scan_history (
      id BIGINT NOT NULL AUTO_INCREMENT,
      qrCode VARCHAR(255) NOT NULL,
      jobNumber VARCHAR(255) NULL,
      assemblyMark VARCHAR(255) NULL,
      stationId INT NULL,
      stationName VARCHAR(255) NULL,
      routeName VARCHAR(255) NULL,
      routeOrder INT NULL,
      stageName VARCHAR(255) NOT NULL,
      scannedBy VARCHAR(255) NULL,
      note TEXT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_qr_code (qrCode),
      INDEX idx_stage_name (stageName),
      INDEX idx_job_number (jobNumber)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await mysqlConnection.query(`
    CREATE TABLE IF NOT EXISTS assembly_station_routes (
      id BIGINT NOT NULL AUTO_INCREMENT,
      routeName VARCHAR(255) NOT NULL,
      stationId INT NOT NULL,
      stationName VARCHAR(255) NOT NULL,
      routeOrder INT NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_route_station (routeName, routeOrder)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await mysqlConnection.query(`
    CREATE TABLE IF NOT EXISTS assembly_station_updates (
      id BIGINT NOT NULL AUTO_INCREMENT,
      qrCode VARCHAR(255) NOT NULL,
      mainMark VARCHAR(255) NULL,
      pieceMark VARCHAR(255) NULL,
      sequenceValue VARCHAR(100) NULL,
      lotNumber VARCHAR(100) NULL,
      quantity DECIMAL(18,3) NULL,
      instanceNumber VARCHAR(100) NULL,
      app VARCHAR(100) NULL,
      inspectionFailures INT NULL,
      completedBy VARCHAR(255) NULL,
      hours DECIMAL(18,3) NULL,
      minutes DECIMAL(18,3) NULL,
      batchId VARCHAR(255) NULL,
      workArea VARCHAR(255) NULL,
      weight VARCHAR(255) NULL,
      finish VARCHAR(255) NULL,
      nextStation VARCHAR(255) NULL,
      remark TEXT NULL,
      includeIfPreviousStationNotCompleted BOOLEAN NOT NULL DEFAULT FALSE,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_station_update_qr (qrCode),
      INDEX idx_station_update_created (qrCode, createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await mysqlConnection.query(`
    CREATE TABLE IF NOT EXISTS contractor_users (
      id BIGINT NOT NULL AUTO_INCREMENT,
      username VARCHAR(100) NOT NULL UNIQUE,
      passwordHash VARCHAR(255) NOT NULL,
      contractorName VARCHAR(255) NOT NULL,
      userGroup VARCHAR(100) NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      canManageAccess BOOLEAN NOT NULL DEFAULT FALSE,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const [accessAdminColumn] = await mysqlConnection.query(`SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='contractor_users' AND COLUMN_NAME='canManageAccess' LIMIT 1`);
  if (!(accessAdminColumn as Array<Record<string, any>>).length) await mysqlConnection.query('ALTER TABLE contractor_users ADD COLUMN canManageAccess BOOLEAN NOT NULL DEFAULT FALSE');
  const [userGroupColumn] = await mysqlConnection.query(`SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='contractor_users' AND COLUMN_NAME='userGroup' LIMIT 1`);
  if (!(userGroupColumn as Array<Record<string, any>>).length) await mysqlConnection.query("ALTER TABLE contractor_users ADD COLUMN userGroup VARCHAR(100) NOT NULL DEFAULT ''");

  await mysqlConnection.query(`
    CREATE TABLE IF NOT EXISTS contractor_project_assignments (
      contractorId BIGINT NOT NULL,
      jobNumber VARCHAR(255) NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (contractorId, jobNumber),
      INDEX idx_assignment_job (jobNumber)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlConnection.query(`
    CREATE TABLE IF NOT EXISTS contractor_feature_permissions (
      contractorId BIGINT NOT NULL,
      featureName VARCHAR(100) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (contractorId, featureName),
      INDEX idx_feature_permission_name (featureName),
      CONSTRAINT fk_feature_permission_contractor FOREIGN KEY (contractorId) REFERENCES contractor_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlConnection.query("UPDATE contractor_feature_permissions SET featureName='SHIPPING' WHERE featureName='SHIFT_TO_PAINT'");

  await mysqlConnection.query(`
    CREATE TABLE IF NOT EXISTS contractor_fitup_inspections (
      id BIGINT NOT NULL AUTO_INCREMENT,
      contractorId BIGINT NOT NULL,
      qrCode VARCHAR(255) NOT NULL,
      jobNumber VARCHAR(255) NOT NULL,
      assemblyMark VARCHAR(255) NOT NULL,
      inspectionType VARCHAR(30) NOT NULL DEFAULT 'VENDOR_FITUP',
      result VARCHAR(30) NOT NULL,
      inspector VARCHAR(255) NOT NULL,
      remarks TEXT NULL,
      checks JSON NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_fitup_qr (qrCode),
      INDEX idx_fitup_contractor (contractorId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const [inspectionTypeColumns] = await mysqlConnection.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contractor_fitup_inspections' AND COLUMN_NAME = 'inspectionType'
     LIMIT 1`
  );
  if (!(inspectionTypeColumns as Array<Record<string, any>>).length) {
    await mysqlConnection.query(
      `ALTER TABLE contractor_fitup_inspections
       ADD COLUMN inspectionType VARCHAR(30) NOT NULL DEFAULT 'VENDOR_FITUP'`
    );
  }
  const [inspectionJobDateIndexes] = await mysqlConnection.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contractor_fitup_inspections' AND INDEX_NAME = 'idx_fitup_job_created'
     LIMIT 1`
  );
  if (!(inspectionJobDateIndexes as Array<Record<string, any>>).length) {
    await mysqlConnection.query(
      `ALTER TABLE contractor_fitup_inspections
       ADD INDEX idx_fitup_job_created (jobNumber, createdAt)`
    );
  }

  await mysqlConnection.query(`
    CREATE TABLE IF NOT EXISTS shipping_tickets (
      id BIGINT NOT NULL AUTO_INCREMENT,
      ticketNumber VARCHAR(64) NOT NULL UNIQUE,
      jobNumber VARCHAR(255) NOT NULL,
      contractorId BIGINT NOT NULL,
      shippingDate DATE NULL,
      destination VARCHAR(500) NULL,
      remarks TEXT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_shipping_ticket_job (jobNumber)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlConnection.query(`
    CREATE TABLE IF NOT EXISTS shipping_ticket_items (
      id BIGINT NOT NULL AUTO_INCREMENT,
      shippingTicketId BIGINT NOT NULL,
      qrCode VARCHAR(255) NOT NULL,
      assemblyMark VARCHAR(255) NOT NULL,
      quantity DECIMAL(18,3) NOT NULL DEFAULT 0,
      weight DECIMAL(18,3) NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      UNIQUE KEY uq_shipping_ticket_item (shippingTicketId, qrCode),
      INDEX idx_shipping_ticket_item_qr (qrCode),
      CONSTRAINT fk_shipping_ticket_items_ticket FOREIGN KEY (shippingTicketId) REFERENCES shipping_tickets(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlConnection.query(`
    CREATE TABLE IF NOT EXISTS shipping_ticket_receipts (
      id BIGINT NOT NULL AUTO_INCREMENT,
      shippingTicketId BIGINT NOT NULL,
      qrCode VARCHAR(255) NOT NULL,
      receivedBy BIGINT NOT NULL,
      receivedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_shipping_ticket_receipt (shippingTicketId, qrCode),
      INDEX idx_shipping_receipt_ticket (shippingTicketId),
      CONSTRAINT fk_shipping_ticket_receipt_ticket FOREIGN KEY (shippingTicketId) REFERENCES shipping_tickets(id) ON DELETE CASCADE,
      CONSTRAINT fk_shipping_ticket_receipt_user FOREIGN KEY (receivedBy) REFERENCES contractor_users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlConnection.query(`
    CREATE TABLE IF NOT EXISTS shipping_ticket_returns (
      id BIGINT NOT NULL AUTO_INCREMENT,
      shippingTicketId BIGINT NOT NULL,
      qrCode VARCHAR(255) NOT NULL,
      returnedBy BIGINT NOT NULL,
      reason VARCHAR(1000) NULL,
      returnedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_shipping_ticket_return (shippingTicketId, qrCode),
      CONSTRAINT fk_shipping_ticket_return_ticket FOREIGN KEY (shippingTicketId) REFERENCES shipping_tickets(id) ON DELETE CASCADE,
      CONSTRAINT fk_shipping_ticket_return_user FOREIGN KEY (returnedBy) REFERENCES contractor_users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const bootstrapUsername = String(process.env.CONTRACTOR_BOOTSTRAP_USERNAME ?? '').trim();
  const bootstrapPassword = String(process.env.CONTRACTOR_BOOTSTRAP_PASSWORD ?? '');
  const bootstrapName = String(process.env.CONTRACTOR_BOOTSTRAP_NAME ?? '').trim();
  const accessAdminUsername = String(process.env.CONTRACTOR_ACCESS_ADMIN_USERNAME ?? '').trim();
  if (bootstrapUsername && bootstrapPassword && bootstrapName) {
    await mysqlConnection.query(
      'INSERT INTO contractor_users (username, passwordHash, contractorName, active) VALUES (?, ?, ?, TRUE) ON DUPLICATE KEY UPDATE passwordHash = VALUES(passwordHash), contractorName = VALUES(contractorName), active = TRUE',
      [bootstrapUsername, hashContractorPassword(bootstrapPassword), bootstrapName]
    );
    const [contractorRows] = await mysqlConnection.query('SELECT id FROM contractor_users WHERE username = ? LIMIT 1', [bootstrapUsername]);
    const contractorId = Number((contractorRows as Array<Record<string, any>>)[0]?.id ?? 0);
    const projects = String(process.env.CONTRACTOR_BOOTSTRAP_PROJECTS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    for (const jobNumber of projects) {
      await mysqlConnection.query('INSERT IGNORE INTO contractor_project_assignments (contractorId, jobNumber) VALUES (?, ?)', [contractorId, jobNumber]);
    }
  }
  if (accessAdminUsername) await mysqlConnection.query('UPDATE contractor_users SET canManageAccess=TRUE WHERE username=?', [accessAdminUsername]);
}

function buildAssemblyQrCode(jobNumber: string, assemblyKey: string | number) {
  const base = `${String(jobNumber || 'powerfab').replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}-${String(assemblyKey || 'assembly')}`;
  return `pf-${createHash('sha256').update(base).digest('hex').slice(0, 12)}`;
}

function buildAssemblyInstanceMark(jobNumber: string, assemblyMark: string, instanceNumber: number) {
  return `${jobNumber}-${assemblyMark}-${instanceNumber}`;
}

function normalizeAssemblyQrCode(value: string) {
  const rawValue = String(value || '').trim();
  if (!rawValue) return '';
  try {
    const parsed = new URL(rawValue);
    return parsed.searchParams.get('qr')?.trim() || rawValue;
  } catch {
    return rawValue;
  }
}

async function findAssemblyRecordByQrCode(qrCode: string) {
  const normalizedQrCode = normalizeAssemblyQrCode(qrCode);
  if (!normalizedQrCode) return null;

  const [jobRows] = await mysqlConnection.query(
    'SELECT `ProductionControlID`, `JobNumber` FROM `productioncontroljobs` WHERE `JobNumber` IS NOT NULL ORDER BY `ProductionControlID` ASC LIMIT 200'
  );

  const jobs = jobRows as Array<Record<string, any>>;
  for (const job of jobs) {
    const productionControlId = Number(job.ProductionControlID ?? 0);
    const jobNumber = String(job.JobNumber ?? '').trim();
    if (!productionControlId || !jobNumber) continue;

    const [assemblyRows] = await mysqlConnection.query(
      'SELECT `ProductionControlAssemblyID`, `MainMark`, `AssemblyQuantity`, `AssemblyWeightEach`, `GrossAssemblyWeightEach`, `AssemblyLengthEach`, `AssemblySquareMetersEach`, `AssemblySurfaceAreaEach` FROM `productioncontrolassemblies` WHERE `ProductionControlID` = ? ORDER BY `ProductionControlAssemblyID` ASC',
      [productionControlId]
    );

    const assemblies = assemblyRows as Array<Record<string, any>>;
    for (const assembly of assemblies) {
      const assemblyId = assembly.ProductionControlAssemblyID ?? null;
      if (assemblyId === null) continue;

      const assemblyQuantity = Number(assembly.AssemblyQuantity ?? 0);
      const candidateKeys = [assemblyId, ...Array.from({ length: assemblyQuantity }, (_value, index) => `${assemblyId}-${index + 1}`)];
      const matchedKey = candidateKeys.find((key) => buildAssemblyQrCode(jobNumber, key) === normalizedQrCode);
      if (matchedKey !== undefined) {
        return {
          qrCode: normalizedQrCode,
          jobNumber,
          productionControlID: productionControlId,
          productionControlAssemblyID: Number(assemblyId),
          instanceNumber: typeof matchedKey === 'string' && matchedKey.startsWith(`${assemblyId}-`) ? Number(matchedKey.slice(String(assemblyId).length + 1)) : null,
          assemblyMark: String(assembly.MainMark ?? '').replace(/\u0001/g, '').trim() || 'Unknown Assembly',
          assemblyQuantity: Number(assembly.AssemblyQuantity ?? 0),
          assemblyWeightEach: Number(assembly.AssemblyWeightEach ?? 0),
          grossAssemblyWeightEach: Number(assembly.GrossAssemblyWeightEach ?? 0),
          assemblyLengthEach: Number(assembly.AssemblyLengthEach ?? 0),
          assemblySquareMetersEach: Number(assembly.AssemblySquareMetersEach ?? 0),
          assemblySurfaceAreaEach: Number(assembly.AssemblySurfaceAreaEach ?? 0)
        };
      }
    }
  }

  return null;
}

function getStageHistory(qrCode: string) {
  const current = assemblyStatusStore.get(qrCode);
  return current ? current.history : [];
}

async function syncAssemblyStationToPowerFabTables(options: {
  qrCode: string;
  jobNumber: string;
  assemblyMark: string;
  productionControlID?: number;
  productionControlAssemblyID?: number;
  stage: string;
  stationId?: number | null;
  stationName?: string;
  routeName?: string;
  routeOrder?: number;
  scannedBy?: string;
  note?: string;
  assemblyQuantity?: number;
  assemblyWeightEach?: number;
  grossAssemblyWeightEach?: number;
  assemblyLengthEach?: number;
  assemblySquareMetersEach?: number;
  assemblySurfaceAreaEach?: number;
  hours?: number;
  batchId?: string;
}) {
  const record = await findAssemblyRecordByQrCode(options.qrCode);
  const finalJobNumber = String(options.jobNumber || record?.jobNumber || '').trim();
  const finalAssemblyMark = String(options.assemblyMark || record?.assemblyMark || '').replace(/\u0001/g, '').trim() || 'Unknown Assembly';
  const finalProductionControlId = Number(options.productionControlID ?? record?.productionControlID ?? 0);
  const assemblyQty = Number(options.assemblyQuantity ?? record?.assemblyQuantity ?? 0);
  const stationId = Number(options.stationId ?? 0);

  if (!finalProductionControlId || !finalAssemblyMark || !finalJobNumber) {
    return;
  }

  const stagePosition = fabricationStages.indexOf(options.stage as (typeof fabricationStages)[number]);
  const stationName = String(options.stationName || '').trim() || 'FITUP';
  const routeName = String(options.routeName || '').trim() || 'Fabrication Route';

  try {
    const [itemRows] = await mysqlConnection.query(
      `SELECT REPLACE(MainMark, CHAR(1), '') AS mainMark,
              REPLACE(PieceMark, CHAR(1), '') AS pieceMark,
              Quantity
       FROM productioncontrolitems
       WHERE ProductionControlID = ? AND ProductionControlAssemblyID = ?
       ORDER BY ProductionControlItemID`,
      [finalProductionControlId, Number(options.productionControlAssemblyID ?? record?.productionControlAssemblyID ?? 0)]
    );
    const trackingItems = (itemRows as Array<Record<string, any>>).length > 0
      ? itemRows as Array<Record<string, any>>
      : [{ mainMark: finalAssemblyMark, pieceMark: finalAssemblyMark, Quantity: Math.max(assemblyQty, 1) }];

    for (const item of trackingItems) {
      await mysqlConnection.query(
        `INSERT INTO \`productioncontrolitemstations\` (
          ProductionControlID, MainMark, PieceMark, SequenceID, StationID, Quantity,
          WorkAreaID, UserID, DateCompleted, TimeCompleted, Hours, BatchID
        ) VALUES (?, ?, ?, 0, ?, ?, NULL, 0, CURDATE(), CURTIME(), ?, ?)`,
        [
          finalProductionControlId,
          String(item.mainMark || finalAssemblyMark).trim(),
          String(item.pieceMark || finalAssemblyMark).trim() || finalAssemblyMark,
          stationId || 0,
            Math.max(Number(item.Quantity ?? 0), 1),
          Number(options.hours ?? 0),
          options.batchId || `${finalJobNumber}-${finalAssemblyMark}`
        ]
      );
    }

      const previousStationId = stationId > 0 ? Math.max(stationId - 1, 0) : null;
      const nextStationId = stationId > 0 ? stationId + 1 : null;

      await mysqlConnection.query(
        `INSERT INTO \`productioncontrolitemstationsummary\` (
          ProductionControlItemID,
          ProductionControlID,
          SequenceID,
          StationID,
          StationType,
          PositionInRoute,
          TotalQuantity,
          QuantityCompleted,
          Hours,
          LastDateCompleted,
          FailedInspectionTestQuantity,
          PreviousStationID,
          PreviousStationQuantityCompleted,
          NextStationID,
          NextStationQuantityCompleted,
          ProductionLengthEach,
          ProductionSquareMetersEach,
          ProductionWeightEach,
          ProductionGrossWeightEach,
          ProductionModelWeightEach,
          ProductionSurfaceAreaEach
        ) VALUES (?, ?, 0, ?, 0, ?, ?, 1, 0, CURDATE(), 0, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          StationID = VALUES(StationID), PositionInRoute = VALUES(PositionInRoute),
          TotalQuantity = VALUES(TotalQuantity), QuantityCompleted = VALUES(QuantityCompleted),
          LastDateCompleted = VALUES(LastDateCompleted), PreviousStationID = VALUES(PreviousStationID),
          NextStationID = VALUES(NextStationID), ProductionLengthEach = VALUES(ProductionLengthEach),
          ProductionSquareMetersEach = VALUES(ProductionSquareMetersEach), ProductionWeightEach = VALUES(ProductionWeightEach),
          ProductionGrossWeightEach = VALUES(ProductionGrossWeightEach), ProductionModelWeightEach = VALUES(ProductionModelWeightEach),
          ProductionSurfaceAreaEach = VALUES(ProductionSurfaceAreaEach)`,
        [
          Number(options.productionControlAssemblyID ?? record?.productionControlAssemblyID ?? 0) || 0,
          finalProductionControlId,
          stationId || 0,
          Math.max(stagePosition, 0) + 1,
          Math.max(assemblyQty, 1),
          previousStationId,
          nextStationId,
          Number(options.assemblyLengthEach ?? record?.assemblyLengthEach ?? 0),
          Number(options.assemblySquareMetersEach ?? record?.assemblySquareMetersEach ?? 0),
          Number(options.assemblyWeightEach ?? record?.assemblyWeightEach ?? 0),
          Number(options.grossAssemblyWeightEach ?? record?.grossAssemblyWeightEach ?? 0),
          Number(options.assemblyWeightEach ?? record?.assemblyWeightEach ?? 0),
          Number(options.assemblySurfaceAreaEach ?? record?.assemblySurfaceAreaEach ?? 0)
        ]
      );
  } catch (error) {
    console.error('Unable to sync assembly stage to real PowerFab tables', error);
    throw new Error('Unable to write the scan to PowerFab tables.', { cause: error });
  }
}

async function backfillHistoricalAssemblyScans() {
  const [rows] = await mysqlConnection.query(
    `SELECT id, qrCode, jobNumber, assemblyMark, stationId, stationName, routeName, routeOrder, stageName, scannedBy, note
     FROM assembly_scan_history
     ORDER BY createdAt ASC, id ASC`
  );
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows as Array<Record<string, any>>) {
    const jobNumber = String(row.jobNumber ?? '').trim();
    const assemblyMark = String(row.assemblyMark ?? '').replace(/\u0001/g, '').trim();
    const stationId = Number(row.stationId ?? 0);
    if (!jobNumber || !assemblyMark || !stationId) {
      failed += 1;
      console.error(`Skipping historical scan ${row.id}: missing job, assembly, or station data.`);
      continue;
    }

    const batchId = `${jobNumber}-${assemblyMark}`;
    const [existingRows] = await mysqlConnection.query(
      `SELECT 1 FROM productioncontrolitemstations WHERE BatchID = ? AND StationID = ? LIMIT 1`,
      [batchId, stationId]
    );
    if ((existingRows as Array<Record<string, any>>).length > 0) {
      skipped += 1;
      continue;
    }

    try {
      await syncAssemblyStationToPowerFabTables({
        qrCode: String(row.qrCode),
        jobNumber,
        assemblyMark,
        stage: String(row.stageName),
        stationId,
        stationName: String(row.stationName ?? ''),
        routeName: String(row.routeName ?? ''),
        routeOrder: Number(row.routeOrder ?? 0),
        scannedBy: String(row.scannedBy ?? 'historical-backfill'),
        note: String(row.note ?? 'Historical scan backfill'),
        batchId
      });
      synced += 1;
    } catch (error) {
      failed += 1;
      console.error(`Unable to backfill historical scan ${row.id}`, error);
    }
  }

  console.log(`Historical scan backfill complete: ${synced} synced, ${skipped} already present, ${failed} failed.`);
}

async function getStationsFromDatabase() {
  const [rows] = await mysqlConnection.query('SELECT * FROM `stations` ORDER BY `StationNumber` ASC, `StationID` ASC');
  return rows as Array<Record<string, any>>;
}

async function getAssignedAssemblyRoute() {
  const [rows] = await mysqlConnection.query(`
    SELECT r.RouteID, r.Description AS routeName, rs.StationOrder AS routeOrder, s.StationID, s.Description AS stationName
    FROM \`routes\` r
    LEFT JOIN \`routestations\` rs ON rs.RouteID = r.RouteID
    LEFT JOIN \`stations\` s ON s.StationID = rs.StationID
    ORDER BY r.RouteID, rs.StationOrder
  `);
  return rows as Array<Record<string, any>>;
}

async function resolveStationByStage(stage: string) {
  const stageName = String(stage || '').trim();
  const stationRows = await getStationsFromDatabase();
  const keywords: Record<string, string[]> = {
    Fitup: ['fitup'],
    Inspection: ['inspection', 'ndt'],
    'Shifting to Paint': ['shift', 'paint'],
    Painting: ['painting'],
    Laydown: ['laydown'],
    'Shifting to Site': ['site', 'shifting to site']
  };

  const targetKeywords = keywords[stageName as keyof typeof keywords] ?? [stageName.toLowerCase()];
  const match = stationRows.find((station) => {
    const description = String(station.Description ?? '').toLowerCase();
    return targetKeywords.some((keyword) => description.includes(keyword));
  });

  return match ?? null;
}

async function getAllowedNextStage(qrCode: string) {
  const [rows] = await mysqlConnection.query(
    'SELECT stageName FROM `assembly_scan_history` WHERE `qrCode` = ? ORDER BY `createdAt` DESC LIMIT 1',
    [qrCode]
  );
  const latest = (rows as Array<Record<string, any>>)[0];
  const previousStage = latest ? String(latest.stageName ?? '') : '';

  const routeOrder = fabricationStages.findIndex((stage) => stage === previousStage);
  const currentIndex = previousStage ? Math.max(routeOrder, 0) : -1;
  return fabricationStages[currentIndex + 1] ?? null;
}

const instanceInput = z.object({
  modelNumber: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().trim().optional(),
  site: z.string().trim().optional(),
  projectName: z.string().trim().optional(),
  plant: z.string().trim().optional(),
  unit: z.string().trim().optional(),
  jobNumber: z.string().trim().optional(),
  assemblyNumber: z.string().trim().optional(),
  location: z.string().trim().optional(),
  status: z.enum(statuses as [string, ...string[]]).optional()
});
const statusInput = z.object({
  status: z.enum(statuses as [string, ...string[]]),
  note: z.string().trim().max(500).optional(),
  updatedBy: z.string().trim().max(100).optional()
});
const stationUpdateInput = z.object({
  mainMark: z.string().trim().max(255).optional(),
  pieceMark: z.string().trim().max(255).optional(),
  sequenceValue: z.string().trim().max(100).optional(),
  lotNumber: z.string().trim().max(100).optional(),
  quantity: z.coerce.number().finite().nonnegative().optional(),
  instanceNumber: z.string().trim().max(100).optional(),
  app: z.string().trim().max(100).optional(),
  inspectionFailures: z.coerce.number().int().nonnegative().optional(),
  completedBy: z.string().trim().max(255).optional(),
  hours: z.coerce.number().finite().nonnegative().optional(),
  minutes: z.coerce.number().finite().nonnegative().optional(),
  batchId: z.string().trim().max(255).optional(),
  workArea: z.string().trim().max(255).optional(),
  weight: z.string().trim().max(255).optional(),
  finish: z.string().trim().max(255).optional(),
  nextStation: z.string().trim().max(255).optional(),
  remark: z.string().trim().max(2000).optional(),
  includeIfPreviousStationNotCompleted: z.boolean().optional()
});

const instanceSelect = {
  id: true, qrCode: true, modelNumber: true, name: true, description: true, site: true, projectName: true, plant: true, unit: true, jobNumber: true, assemblyNumber: true,
  status: true, location: true, createdAt: true, updatedAt: true
} as const;

function presentInstance(instance: { id: string; qrCode: string; modelNumber: string; name: string; description: string | null; site: string | null; projectName: string | null; plant: string | null; unit: string | null; jobNumber: string | null; assemblyNumber: string | null; status: FabricationStatus; location: string | null; createdAt: Date; updatedAt: Date }) {
  return {
    ...instance,
    qrImageUrl: `${publicAppUrl}/api/instances/${instance.qrCode}/qr`,
    printUrl: `${publicAppUrl}/api/instances/${instance.qrCode}/print`
  };
}

app.get('/health', (_request, response) => response.json({ ok: true }));

app.get('/api/statuses', (_request, response) => response.json({ statuses }));

const contractorLoginInput = z.object({ username: z.string().trim().min(1), password: z.string().min(1) });
const fitupInspectionInput = z.object({
  result: z.enum(['PASS', 'FAIL', 'HOLD', 'RE-INSPECTION REQUIRED']),
  inspector: z.string().trim().min(1).max(255),
  remarks: z.string().trim().max(4000).optional(),
  checks: z.record(z.string(), z.unknown()).optional()
});
const shippingTicketInput = z.object({
  qrCodes: z.array(z.string().trim().min(1)).min(1).max(500),
  shippingDate: z.string().trim().max(10).optional(),
  destination: z.string().trim().max(500).optional(),
  remarks: z.string().trim().max(4000).optional()
});

async function getPowerFabUserGroup(username: string) {
  const [columns] = await mysqlConnection.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users'
       AND COLUMN_NAME IN ('Group', 'GroupName', 'UserGroup', 'ExternalUserGroup')
     ORDER BY FIELD(COLUMN_NAME, 'Group', 'GroupName', 'UserGroup', 'ExternalUserGroup') LIMIT 1`
  );
  const column = (columns as Array<Record<string, any>>)[0]?.COLUMN_NAME;
  if (!column) return '';
  const [rows] = await mysqlConnection.query(`SELECT \`${column}\` AS userGroup FROM users WHERE Username = ? LIMIT 1`, [username]);
  return String((rows as Array<Record<string, any>>)[0]?.userGroup ?? '').trim();
}

function isShippingGroup(userGroup: unknown) {
  const normalized = String(userGroup ?? '').trim().toLowerCase();
  return normalized === 'fabrication' || normalized === 'coating';
}

function isCoatingGroup(userGroup: unknown) {
  return String(userGroup ?? '').trim().toLowerCase() === 'coating';
}

async function hasConfirmedShippingReceipt(qrCode: string) {
  const [rows] = await mysqlConnection.query(
    'SELECT 1 FROM shipping_ticket_receipts WHERE qrCode=? LIMIT 1',
    [normalizeAssemblyQrCode(qrCode)]
  );
  return (rows as Array<Record<string, any>>).length > 0;
}

async function syncShippingInstanceState(qrCode: string, state: 'received' | 'returned') {
  const assembly = await findAssemblyRecordByQrCode(qrCode);
  if (!assembly || !assembly.instanceNumber) return false;

  const instanceFilter = [
    assembly.productionControlID,
    assembly.productionControlAssemblyID,
    assembly.instanceNumber
  ];
  if (state === 'received') {
    await mysqlConnection.query(
      `UPDATE productioncontroltrucks t
       JOIN productioncontrolitemtrucks pit ON pit.TruckID = t.TruckID
       JOIN productioncontrolitems pci ON pci.ProductionControlID = pit.ProductionControlID
        AND pci.MainMark = pit.MainMark
       JOIN productioncontrolitemtruckinstancenumbers pi ON pi.ProductionControlItemTruckID = pit.ProductionControlItemTruckID
        AND pi.ProductionControlItemID = pci.ProductionControlItemID
       SET t.DateReceived = COALESCE(t.DateReceived, CURDATE()), t.RecalculateTruckTotals = 1
       WHERE pit.ProductionControlID = ? AND pci.ProductionControlAssemblyID = ? AND pi.InstanceNumber = ?`,
      instanceFilter
    );
  } else {
    await mysqlConnection.query(
      `UPDATE productioncontrolitemtruckinstancenumbers pi
       JOIN productioncontrolitemtrucks pit ON pit.ProductionControlItemTruckID = pi.ProductionControlItemTruckID
       JOIN productioncontrolitems pci ON pci.ProductionControlItemID = pi.ProductionControlItemID
       SET pi.DateReturned = COALESCE(pi.DateReturned, CURDATE()),
           pit.QuantityReturned = LEAST(pit.Quantity, pit.QuantityReturned + 1),
           pit.RecalculateTruckTotals = 1
       WHERE pit.ProductionControlID = ? AND pci.ProductionControlAssemblyID = ? AND pi.InstanceNumber = ?`,
      instanceFilter
    );
    await mysqlConnection.query(
      `UPDATE productioncontroltrucks t
       SET t.QuantityReturned = (
         SELECT COALESCE(SUM(pit.QuantityReturned), 0)
         FROM productioncontrolitemtrucks pit
         WHERE pit.TruckID = t.TruckID
       ), t.RecalculateTruckTotals = 1
       WHERE t.TruckID IN (
         SELECT truckId FROM (
           SELECT DISTINCT pit2.TruckID AS truckId
           FROM productioncontrolitemtrucks pit2
           JOIN productioncontrolitems pci2 ON pci2.ProductionControlID = pit2.ProductionControlID
            AND pci2.MainMark = pit2.MainMark
           JOIN productioncontrolitemtruckinstancenumbers pi2 ON pi2.ProductionControlItemTruckID = pit2.ProductionControlItemTruckID
            AND pi2.ProductionControlItemID = pci2.ProductionControlItemID
           WHERE pit2.ProductionControlID = ? AND pci2.ProductionControlAssemblyID = ? AND pi2.InstanceNumber = ?
         ) matchingTrucks
       )`,
      instanceFilter
    );
  }
  return true;
}

app.post('/api/auth/login', async (request, response) => {
  const input = contractorLoginInput.safeParse(request.body);
  if (!input.success) return response.status(400).json({ error: 'Username and password are required.' });
  let contractor: Record<string, any> | undefined;

  const [powerFabRows] = await mysqlConnection.query(
    'SELECT Username, FirstName, LastName, PasswordHash, Active, ExternalUser, HasLoginPermission, HasRLPermission FROM users WHERE Username = ? LIMIT 1',
    [input.data.username]
  );
  const powerFabUser = (powerFabRows as Array<Record<string, any>>)[0];
  const hasRemoteLoginPermission = powerFabUser && (powerFabUser.HasLoginPermission || powerFabUser.HasRLPermission);
  if (powerFabUser && powerFabUser.Active && hasRemoteLoginPermission && verifyPowerFabPassword(input.data.password, powerFabUser.PasswordHash)) {
    const contractorName = [powerFabUser.FirstName, powerFabUser.LastName].filter(Boolean).join(' ') || powerFabUser.Username;
    const userGroup = await getPowerFabUserGroup(powerFabUser.Username);
    await mysqlConnection.query(
      'INSERT INTO contractor_users (username, passwordHash, contractorName, userGroup, active) VALUES (?, ?, ?, ?, TRUE) ON DUPLICATE KEY UPDATE contractorName = VALUES(contractorName), userGroup = VALUES(userGroup), active = TRUE',
      [powerFabUser.Username, hashContractorPassword(randomBytes(32).toString('hex')), contractorName, userGroup]
    );
    const [contractorRows] = await mysqlConnection.query('SELECT id, username, contractorName, userGroup FROM contractor_users WHERE username = ? AND active = TRUE LIMIT 1', [powerFabUser.Username]);
    contractor = (contractorRows as Array<Record<string, any>>)[0];
  } else {
    const [rows] = await mysqlConnection.query('SELECT id, username, contractorName, userGroup, passwordHash FROM contractor_users WHERE username = ? AND active = TRUE LIMIT 1', [input.data.username]);
    const localContractor = (rows as Array<Record<string, any>>)[0];
    if (localContractor && verifyContractorPassword(input.data.password, localContractor.passwordHash)) contractor = localContractor;
  }
  if (!contractor) return response.status(401).json({ error: 'Invalid contractor login.' });
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  upsertContractorSession(contractorSessionStoreFile, token, Number(contractor.id), expiresAt);
  contractorSessions.set(token, { contractorId: Number(contractor.id), expiresAt });
  response.setHeader('Set-Cookie', `powerfab_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
  response.json({ contractor: { username: contractor.username, contractorName: contractor.contractorName, userGroup: contractor.userGroup } });
});

app.post('/api/auth/logout', (request, response) => {
  const token = getSessionToken(request);
  if (token) {
    contractorSessions.delete(token);
    deleteContractorSession(contractorSessionStoreFile, token);
  }
  response.setHeader('Set-Cookie', 'powerfab_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  response.json({ ok: true });
});

app.get('/api/auth/me', async (request, response) => {
  const contractorId = getContractorId(request);
  if (!contractorId) return response.status(401).json({ error: 'Contractor login required.' });
  const [rows] = await mysqlConnection.query('SELECT username, contractorName, userGroup FROM contractor_users WHERE id = ? AND active = TRUE LIMIT 1', [contractorId]);
  const contractor = (rows as Array<Record<string, any>>)[0];
  if (!contractor) return response.status(401).json({ error: 'Contractor login required.' });
  const [permissionRows] = await mysqlConnection.query(
    'SELECT enabled FROM contractor_feature_permissions WHERE contractorId = ? AND featureName = ? LIMIT 1',
    [contractorId, 'SHIPPING']
  );
  const shippingPermission = Boolean((permissionRows as Array<Record<string, any>>)[0]?.enabled);
  const userGroup = await getContractorGroup(contractorId);
  contractor.userGroup = userGroup;
  response.json({ contractor, permissions: { shipping: shippingPermission || isShippingGroup(userGroup), shiftToPaint: shippingPermission || isShippingGroup(userGroup), canConfirmReceipt: isCoatingGroup(userGroup) } });
});

async function requireAccessAdmin(request: express.Request, response: express.Response) {
  const contractorId = getContractorId(request);
  if (!contractorId) { response.status(401).json({ error: 'Contractor login required.' }); return null; }
  const [rows] = await mysqlConnection.query('SELECT id,username,contractorName FROM contractor_users WHERE id=? AND active=TRUE AND canManageAccess=TRUE LIMIT 1', [contractorId]);
  if (!(rows as Array<Record<string, any>>).length) { response.status(403).json({ error: 'Access management permission is required.' }); return null; }
  return contractorId;
}

async function isAccessAdmin(contractorId: number) {
  const [rows] = await mysqlConnection.query('SELECT 1 FROM contractor_users WHERE id=? AND active=TRUE AND canManageAccess=TRUE LIMIT 1', [contractorId]);
  return (rows as Array<Record<string, any>>).length > 0;
}

async function getContractorGroup(contractorId: number) {
  const [rows] = await mysqlConnection.query('SELECT username, userGroup FROM contractor_users WHERE id=? AND active=TRUE LIMIT 1', [contractorId]);
  const contractor = (rows as Array<Record<string, any>>)[0];
  const currentGroup = String(contractor?.userGroup ?? '').trim();
  if (!contractor?.username) return currentGroup;
  const powerFabGroup = await getPowerFabUserGroup(String(contractor.username));
  if (powerFabGroup && powerFabGroup !== currentGroup) {
    await mysqlConnection.query('UPDATE contractor_users SET userGroup=? WHERE id=?', [powerFabGroup, contractorId]);
    return powerFabGroup;
  }
  return currentGroup;
}

async function requireCoatingUser(request: express.Request, response: express.Response) {
  const contractorId = getContractorId(request);
  if (!contractorId) { response.status(401).json({ error: 'Contractor login required.' }); return null; }
  if (!isCoatingGroup(await getContractorGroup(contractorId))) {
    response.status(403).json({ error: 'Only Coating group users can scan, confirm, or return Shipping loads.' });
    return null;
  }
  return contractorId;
}

app.get('/api/admin/feature-permissions', async (request, response) => {
  if (!await requireAccessAdmin(request, response)) return;
  const [rows] = await mysqlConnection.query(`SELECT cu.id,cu.username,cu.contractorName,cu.active,cu.canManageAccess,
    cu.userGroup,
    COALESCE(fp.enabled,FALSE) AS shipping,
    COALESCE(fp.enabled,FALSE) AS shiftToPaint
    FROM contractor_users cu LEFT JOIN contractor_feature_permissions fp ON fp.contractorId=cu.id AND fp.featureName='SHIPPING'
    ORDER BY cu.contractorName,cu.username`);
  response.json({ users: rows });
});

app.put('/api/admin/feature-permissions/:contractorId', async (request, response) => {
  if (!await requireAccessAdmin(request, response)) return;
  const contractorId = Number(request.params.contractorId);
  if (!Number.isInteger(contractorId) || contractorId <= 0) return response.status(400).json({ error: 'Invalid user.' });
  const enabled = Boolean(request.body?.shipping ?? request.body?.shiftToPaint);
  await mysqlConnection.query(`INSERT INTO contractor_feature_permissions (contractorId,featureName,enabled) VALUES (?, 'SHIPPING', ?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled)`, [contractorId, enabled]);
  response.json({ saved: true, contractorId, shipping: enabled, shiftToPaint: enabled });
});

async function loadProjectsFromDatabase() {
  try {
    const rawCandidates = projectTableCandidates.map((tableName) => {
      const jobColumn = projectJobColumn;
      const descriptionColumn = projectDescriptionColumn;
      const siteColumn = projectSiteColumn;
      const plantColumn = projectPlantColumn;
      const unitColumn = projectUnitColumn;
      const locationColumn = projectLocationColumn;
      const statusColumn = projectStatusColumn;
      const updatedAtColumn = projectUpdatedAtColumn;

      if (['projects', 'productioncontroljobs', 'externalprojects'].includes(tableName.toLowerCase())) {
        return `SELECT p.${jobColumn} AS jobNumber, p.${descriptionColumn} AS description, p.${siteColumn} AS site, p.${plantColumn} AS plant, p.${unitColumn} AS unit, p.${locationColumn} AS location, COALESCE(js.Description, 'PLANNED') AS status, p.${updatedAtColumn} AS updatedAt FROM \`${tableName}\` p LEFT JOIN jobstatuses js ON js.JobStatusID = p.${statusColumn} ORDER BY p.${updatedAtColumn} DESC LIMIT 1000`;
      }

      return `SELECT ${jobColumn} AS jobNumber, ${descriptionColumn} AS description, ${siteColumn} AS site, ${plantColumn} AS plant, ${unitColumn} AS unit, ${locationColumn} AS location, ${statusColumn} AS status, ${updatedAtColumn} AS updatedAt FROM \`${tableName}\` ORDER BY ${updatedAtColumn} DESC LIMIT 1000`;
    });

    for (const sql of rawCandidates) {
      try {
        const [rows] = await mysqlConnection.query(sql);
        const projectRows = rows as Array<{ jobNumber: string | null; description: string | null; site: string | null; plant: string | null; unit: string | null; location: string | null; status: string | null; updatedAt: Date }>;
        if (projectRows && projectRows.length > 0) {
          const jobNumbers = projectRows
            .map((row) => row.jobNumber)
            .filter((jobNumber): jobNumber is string => Boolean(jobNumber));

          const countsByJob = new Map<string, number>();
          if (jobNumbers.length > 0) {
            const placeholders = jobNumbers.map(() => '?').join(',');
            const [countRows] = await mysqlConnection.query(`SELECT JobNumber, NumberOfItems FROM \`productioncontroljobs\` WHERE JobNumber IN (${placeholders})`, jobNumbers);
            const countList = countRows as Array<{ JobNumber: string; NumberOfItems: number | null }>;
            for (const item of countList) {
              if (item.JobNumber) {
                countsByJob.set(item.JobNumber, Number(item.NumberOfItems ?? 0));
              }
            }
          }

          return projectRows.map((row) => ({
            jobNumber: row.jobNumber ?? 'N/A',
            description: row.description ?? 'No description',
            name: row.description ?? 'No description',
            site: row.site ?? '',
            plant: row.plant ?? '',
            unit: row.unit ?? '',
            location: row.location ?? '',
            status: row.status ?? 'PLANNED',
            updatedAt: row.updatedAt ?? new Date(),
            assemblyCount: countsByJob.get(row.jobNumber ?? '') ?? 0
          }));
        }
      } catch {
        // Try the next likely live table name.
      }
    }

    return [];
  } catch (error) {
    console.error('Unable to load project data from database', error);
    return [];
  }
}

app.get('/api/projects', async (request, response, next) => {
  try {
    const contractorId = getContractorId(request);
    if (!contractorId) return response.status(401).json({ error: 'Contractor login required.' });
    const projects = await loadProjectsFromDatabase();
    const accessibleProjects = await Promise.all(
      projects.map(async (project) => (await contractorCanAccessJob(contractorId, String(project.jobNumber))) ? project : null)
    );
    response.json({ projects: accessibleProjects.filter((project): project is NonNullable<typeof project> => project !== null) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database error';
    response.status(500).json({
      error: `PowerFab database unavailable: ${message}. Set DATABASE_URL to the live MySQL connection.`
    });
  }
});

async function getSingleValue(query: string, values: unknown[] = []) {
  try {
    const [rows] = await mysqlConnection.query(query, values);
    const rowsArray = rows as Array<Record<string, any>>;
    if (!rowsArray || rowsArray.length === 0) return 0;
    const first = rowsArray[0];
    const value = Object.values(first)[0];
    return Number(value ?? 0);
  } catch {
    return 0;
  }
}

function cleanPowerFabValue(value: unknown) {
  return String(value ?? '').replace(/\u0001/g, '').trim() || '—';
}

function parseIndiaDateTime(value: unknown) {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) return new Date();
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawValue)
    ? new Date(rawValue)
    : new Date(`${rawValue.length === 16 ? `${rawValue}:00` : rawValue}+05:30`);
}

function hashContractorPassword(password: string, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

function verifyContractorPassword(password: string, storedHash: string) {
  const [salt, expected] = String(storedHash).split(':');
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 32);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function verifyPowerFabPassword(password: string, storedHash: string) {
  const expectedBuffer = Buffer.from(String(storedHash ?? ''), 'hex');
  const actual = createHash('sha1').update(password).digest();
  return expectedBuffer.length === actual.length && timingSafeEqual(actual, expectedBuffer);
}

function getSessionToken(request: express.Request) {
  const cookie = String(request.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith('powerfab_session='));
  return cookie?.split('=')[1] ?? '';
}

function getContractorId(request: express.Request) {
  const token = getSessionToken(request);
  const session = contractorSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) {
      contractorSessions.delete(token);
      deleteContractorSession(contractorSessionStoreFile, token);
    }
    return null;
  }
  return session.contractorId;
}

async function contractorCanAccessJob(contractorId: number, jobNumber: string) {
  const [assignedRows] = await mysqlConnection.query('SELECT 1 FROM contractor_project_assignments WHERE contractorId = ? AND jobNumber = ? LIMIT 1', [contractorId, jobNumber]);
  if ((assignedRows as Array<Record<string, any>>).length > 0) return true;

  const [powerFabRows] = await mysqlConnection.query(
    `SELECT 1
     FROM contractor_users cu
     JOIN users u ON u.Username = cu.username AND u.Active = 1
     JOIN useraccess ua ON ua.UserID = u.UserID AND ua.Type = 'PDC'
     JOIN productioncontroljobs pcj ON pcj.JobNumber = ? AND CAST(ua.Value AS UNSIGNED) = pcj.ProductionControlID
     WHERE cu.id = ? AND cu.active = TRUE
     LIMIT 1`,
    [jobNumber, contractorId]
  );
  return (powerFabRows as Array<Record<string, any>>).length > 0;
}

async function contractorCanAccessQr(contractorId: number, qrCode: string) {
  const assembly = await findAssemblyRecordByQrCode(qrCode);
  if (!assembly || !(await contractorCanAccessJob(contractorId, assembly.jobNumber))) return null;
  return assembly;
}

async function getFitupInspectionRole(contractorId: number) {
  const group = (await getContractorGroup(contractorId)).toLowerCase();
  if (group === 'fabrication') return 'VENDOR_FITUP' as const;
  if (group === 'mpl') return 'CLIENT_FITUP' as const;
  if (group === 'coating') return 'PAINTING_INSPECTION' as const;
  const [rows] = await mysqlConnection.query(
    `SELECT u.ExternalUser
     FROM contractor_users cu
     JOIN users u ON u.Username = cu.username AND u.Active = 1
     WHERE cu.id = ? AND cu.active = TRUE
     LIMIT 1`,
    [contractorId]
  );
  const user = (rows as Array<Record<string, any>>)[0];
  if (!user || !Boolean(user.ExternalUser)) return 'VENDOR_FITUP' as const;

  const [permissionRows] = await mysqlConnection.query(
    `SELECT ua.Value
     FROM contractor_users cu
     JOIN users u ON u.Username = cu.username AND u.Active = 1
     JOIN useraccess ua ON ua.UserID = u.UserID
    WHERE cu.id = ? AND ua.Type = 'INSP'
     ORDER BY CAST(ua.Value AS UNSIGNED) DESC
     LIMIT 1`,
    [contractorId]
  );
  const permission = Number((permissionRows as Array<Record<string, any>>)[0]?.Value ?? 0);
  if (permission === 1) return 'VENDOR_FITUP' as const;
  if (permission === 2) return 'CLIENT_FITUP' as const;
  return null;
}

type InspectionType = 'VENDOR_FITUP' | 'CLIENT_FITUP' | 'PAINTING_INSPECTION';

async function getInspectionTestId(inspectionType: InspectionType) {
  if (inspectionType === 'VENDOR_FITUP') return 1;
  if (inspectionType === 'CLIENT_FITUP') return 2;
  const [rows] = await mysqlConnection.query(
    `SELECT InspectionTestID
      FROM inspectiontests it
      JOIN inspectionteststrings title ON title.InspectionTestStringID = it.TitleStringID
      WHERE LOWER(title.String) LIKE '%painting%'
        OR LOWER(title.String) LIKE '%paint%'
     ORDER BY InspectionTestID
     LIMIT 1`
  );
  return Number((rows as Array<Record<string, any>>)[0]?.InspectionTestID ?? 3);
}

async function getInspectionLocations() {
  const [rows] = await mysqlConnection.query(
    `SELECT l.InspectionTestLocationID AS id, s.String AS name
     FROM inspectiontestlocations l
     JOIN inspectionteststrings s ON s.InspectionTestStringID = l.LocationStringID
     WHERE l.Active = 1 ORDER BY s.String`
  );
  return rows as Array<{ id: number; name: string }>;
}

async function getProjectInspectorContact(jobNumber: string, username: string) {
  const [rows] = await mysqlConnection.query(
    `SELECT pf.FirmContactID AS contactId, f.Name AS firmName, fc.Name AS contactName
     FROM projects p
     JOIN projectfirms pf ON pf.ProjectID = p.ProjectID
     LEFT JOIN firms f ON f.FirmID = pf.FirmID
     LEFT JOIN firmcontacts fc ON fc.FirmContactID = pf.FirmContactID
     WHERE p.JobNumber = ? AND fc.Inspector = 1
       AND LOWER(TRIM(fc.Name)) = LOWER(TRIM(?))
     ORDER BY pf.ProjectFirmID LIMIT 1`,
    [jobNumber, username]
  );
  return (rows as Array<Record<string, any>>)[0] ?? null;
}

function buildPowerFabDrawingsUrl(productionControlId: number) {
  return powerFabDrawingsUrlTemplate.replace('{productionControlId}', encodeURIComponent(String(productionControlId)));
}

app.get('/api/stations', async (_request, response) => {
  try {
    const stations = await getStationsFromDatabase();
    response.json({ stations });
  } catch (error) {
    console.error('Unable to load stations', error);
    response.status(500).json({ error: 'Failed to load live stations from PowerFab.' });
  }
});

app.get('/api/assembly-routes', async (_request, response) => {
  try {
    const routeRows = await getAssignedAssemblyRoute();
    response.json({ routes: routeRows });
  } catch (error) {
    console.error('Unable to load assembly routes', error);
    response.status(500).json({ error: 'Failed to load assignment routes from PowerFab.' });
  }
});

app.get('/api/project-detail', async (request, response) => {
  const jobNumber = String(request.query.job || '').trim();
  if (!jobNumber) return response.status(400).json({ error: 'job query parameter is required' });
  const contractorId = getContractorId(request);
  if (!contractorId) return response.status(401).json({ error: 'Contractor login required.' });
  if (!(await contractorCanAccessJob(contractorId, jobNumber))) return response.status(403).json({ error: 'Project is not assigned to this contractor.' });

  try {
    const [projectRows] = await mysqlConnection.query('SELECT * FROM `projects` WHERE `JobNumber` = ? LIMIT 1', [jobNumber]);
    const projectList = projectRows as Array<Record<string, any>>;
    const project = projectList[0];

    if (!project) {
      return response.status(404).json({ error: 'Project not found in live PowerFab database.' });
    }

    const projectId = Number(project.ProjectID ?? 0);
    const [productionRows] = await mysqlConnection.query('SELECT * FROM `productioncontroljobs` WHERE `JobNumber` = ? LIMIT 1', [jobNumber]);
    const productionControl = (productionRows as Array<Record<string, any>>)[0] ?? null;
    const productionControlId = productionControl ? Number(productionControl.ProductionControlID ?? 0) : 0;
    const [sequenceRows] = await mysqlConnection.query('SELECT * FROM `productioncontrolsequences` WHERE `ProductionControlID` = ? ORDER BY `SequenceID` LIMIT 50', [productionControlId || null]);
    const sequences = (sequenceRows as Array<Record<string, any>>).map((entry) => ({
      sequenceId: entry.SequenceID ?? null,
      description: cleanPowerFabValue(entry.Description ?? 'Unnamed sequence'),
      lotNumber: entry.LotNumber ?? null,
      quantity: Number(entry.AssemblyQuantity ?? 0),
      workPackageId: entry.WorkPackageID ?? null,
      globalSequenceId: entry.GlobalSequenceID ?? null
    }));

    const [assemblyRows] = await mysqlConnection.query(
      `SELECT
        pca.ProductionControlAssemblyID,
        pca.MainMark,
        pca.AssemblyQuantity,
        pca.AssemblyWeightEach,
        pca.GrossAssemblyWeightEach,
        pca.ModelAssemblyWeightEach,
        pca.AssemblyLengthEach,
        pca.AssemblySquareMetersEach,
        pca.AssemblySurfaceAreaEach,
        (
          SELECT COALESCE(SUM(pci.Quantity), 0)
          FROM \`productioncontrolitems\` pci
          WHERE pci.ProductionControlID = ?
            AND pci.ProductionControlAssemblyID = pca.ProductionControlAssemblyID
        ) AS totalQty,
        (
          SELECT COALESCE(SUM(pci.Weight * pci.Quantity), 0)
          FROM \`productioncontrolitems\` pci
          WHERE pci.ProductionControlID = ?
            AND pci.ProductionControlAssemblyID = pca.ProductionControlAssemblyID
        ) AS totalWeight
      FROM \`productioncontrolassemblies\` pca
      WHERE pca.ProductionControlID = ?
      ORDER BY pca.MainMark
      LIMIT 500`,
      [productionControlId, productionControlId, productionControlId]
    );

    const assemblyList = (assemblyRows as Array<Record<string, any>>).map((row, index) => {
      const productionControlAssemblyId = row.ProductionControlAssemblyID ?? `${jobNumber}-${index}`;
      const qrCode = buildAssemblyQrCode(jobNumber, productionControlAssemblyId);
      const stageEntry = assemblyStatusStore.get(qrCode);
      const stage = stageEntry ? stageEntry.currentStage : 'Fitup';
      const qty = Number(row.AssemblyQuantity ?? 0);
      const weight = Number(row.AssemblyWeightEach ?? 0);

      const assemblyWeightEach = Number(row.AssemblyWeightEach ?? 0);
      const assemblyWeight = Number((assemblyWeightEach * qty).toFixed(3));
      const mainMark = cleanPowerFabValue(row.MainMark ?? '—');

      return {
        productionControlAssemblyId,
        mainMark,
        drawingNumber: mainMark,
        assemblyQuantity: qty,
        totalQty: qty,
        weight: assemblyWeight,
        assemblyWeightEach,
        assemblyWeightTotal: assemblyWeight,
        grossAssemblyWeightEach: Number(row.GrossAssemblyWeightEach ?? 0),
        assemblyLengthEach: Number(row.AssemblyLengthEach ?? 0),
        assemblySquareMetersEach: Number(row.AssemblySquareMetersEach ?? 0),
        assemblySurfaceAreaEach: Number(row.AssemblySurfaceAreaEach ?? 0),
        qrCode,
        fabricationStage: stage,
        statusHistory: getStageHistory(qrCode)
      };
    });

    const projectAssemblyCount = productionControlId
      ? await getSingleValue('SELECT COALESCE(SUM(`AssemblyQuantity`), 0) AS total FROM `productioncontrolassemblies` WHERE `ProductionControlID` = ?', [productionControlId])
      : 0;
    const drawingCount = projectId ? await getSingleValue('SELECT COUNT(*) AS total FROM `drawings` WHERE `ProjectID` = ?', [projectId]) : 0;
    const sequenceCount = productionControlId ? await getSingleValue('SELECT COUNT(*) AS total FROM `productioncontrolsequences` WHERE `ProductionControlID` = ?', [productionControlId]) : 0;
    const categoryCount = projectId ? await getSingleValue('SELECT COUNT(DISTINCT CategoryID) AS total FROM `productioncontrolitems` WHERE `ProductionControlID` = ?', [productionControlId || 0]) : 0;
    const inspectionCount = projectId ? await getSingleValue('SELECT COUNT(*) AS total FROM `inspectiontestrecords` WHERE `ProductionControlID` = ?', [productionControlId || 0]) : 0;
    const shippingVisible = await contractorCanUseShiftToPaint(contractorId);
    const rfiCount = projectId ? await getSingleValue('SELECT COUNT(*) AS total FROM `requestforinformationdrawings` WHERE `ProjectID` = ?', [projectId]) : 0;
    const transmittalCount = projectId ? await getSingleValue('SELECT COUNT(*) AS total FROM `transmittals` WHERE `ProjectID` = ?', [projectId]) : 0;

    const detail = {
      jobNumber: project.JobNumber ?? jobNumber,
      comment2: cleanPowerFabValue(productionControl?.Comment2 ?? project.JobNumber ?? jobNumber),
      jobDescription: project.JobDescription ?? '',
      jobLocation: project.JobLocation ?? '',
      plant: project.GroupName ?? '',
      unit: project.GroupName2 ?? '',
      status: await getSingleValue('SELECT COALESCE((SELECT `Description` FROM `jobstatuses` WHERE `JobStatusID` = ? LIMIT 1), "Open") AS status', [project.JobStatusID]),
      assemblyCount: projectAssemblyCount,
      drawingCount,
      sequenceCount,
      categoryCount,
      inspectionCount,
      rfiCount,
      transmittalCount,
      preparedCutListCount: await getSingleValue('SELECT COUNT(*) AS total FROM `productioncontrolcutlists` WHERE `ProductionControlID` = ?', [productionControlId || 0]),
      materialStatusCount: await getSingleValue('SELECT COUNT(*) AS total FROM `productioncontrolitems` WHERE `ProductionControlID` = ?', [productionControlId || 0]),
      productionTrackingCount: await getSingleValue('SELECT COUNT(*) AS total FROM `productioncontroljobs` WHERE `JobNumber` = ? ', [jobNumber]),
      productionStatusCount: await getSingleValue('SELECT COUNT(*) AS total FROM `productioncontroljobs` WHERE `JobNumber` = ? ', [jobNumber]),
      shippingStatusCount: await getSingleValue('SELECT COUNT(*) AS total FROM `productioncontroljobs` WHERE `JobNumber` = ? ', [jobNumber]),
      canShiftToPaint: shippingVisible,
      canShipping: shippingVisible,
      canShiftToLaydownSite: shippingVisible,
      assemblies: assemblyList,
      projectId,
      drawingsUrl: buildPowerFabDrawingsUrl(productionControlId),
      updatedAt: project.JobDate ?? null
    };

    response.json({ project: detail });
  } catch (error) {
    console.error('Unable to load project detail', error);
    response.status(500).json({ error: 'Failed to load live project detail from PowerFab.' });
  }
});

app.get('/api/project-drawings', async (request, response) => {
  const jobNumber = String(request.query.job || '').trim();
  if (!jobNumber) return response.status(400).json({ error: 'job query parameter is required' });
  const contractorId = getContractorId(request);
  if (!contractorId) return response.status(401).json({ error: 'Contractor login required.' });
  if (!(await contractorCanAccessJob(contractorId, jobNumber))) return response.status(403).json({ error: 'Project is not assigned to this contractor.' });

  try {
    const [projectRows] = await mysqlConnection.query(
      'SELECT ProjectID, JobNumber FROM `projects` WHERE `JobNumber` = ? LIMIT 1',
      [jobNumber]
    );
    const project = (projectRows as Array<Record<string, any>>)[0];
    if (!project) return response.status(404).json({ error: 'Project not found in live PowerFab database.' });

    const [productionRows] = await mysqlConnection.query(
      'SELECT ProductionControlID FROM `productioncontroljobs` WHERE `JobNumber` = ? LIMIT 1',
      [jobNumber]
    );
    const productionControlId = Number((productionRows as Array<Record<string, any>>)[0]?.ProductionControlID ?? 0);
    const [drawingRows] = await mysqlConnection.query(
      `SELECT
        d.DrawingID,
        d.DrawingNumber,
        pcj.Comment2 AS comment2,
        d.Description,
        d.ApprovalStatusID,
        COALESCE(aps.Description, '—') AS approvalStatus,
        COALESCE(dr.Revision, '—') AS revision,
        COALESCE((SELECT MAX(pca.AssemblyQuantity)
          FROM productioncontrolitems pci
          JOIN productioncontrolassemblies pca ON pca.ProductionControlAssemblyID = pci.ProductionControlAssemblyID
          WHERE pci.DrawingID = d.DrawingID
            AND pci.ProductionControlID = ?
            AND NOT (
              LOWER(REPLACE(COALESCE(pci.MainMark, ''), CHAR(1), '')) LIKE '%nutm%'
              OR LOWER(REPLACE(COALESCE(pci.MainMark, ''), CHAR(1), '')) LIKE '%boltm%'
              OR LOWER(REPLACE(COALESCE(pci.MainMark, ''), CHAR(1), '')) LIKE '%washerm%'
              OR LOWER(REPLACE(COALESCE(pci.PieceMark, ''), CHAR(1), '')) LIKE '%nutm%'
              OR LOWER(REPLACE(COALESCE(pci.PieceMark, ''), CHAR(1), '')) LIKE '%boltm%'
              OR LOWER(REPLACE(COALESCE(pci.PieceMark, ''), CHAR(1), '')) LIKE '%washerm%'
            )), 0) AS assemblyQuantity,
        COALESCE((SELECT MAX(pca.AssemblyWeightEach)
          FROM productioncontrolitems pci
          JOIN productioncontrolassemblies pca ON pca.ProductionControlAssemblyID = pci.ProductionControlAssemblyID
          WHERE pci.DrawingID = d.DrawingID
            AND pci.ProductionControlID = ?
            AND NOT (
              LOWER(REPLACE(COALESCE(pci.MainMark, ''), CHAR(1), '')) LIKE '%nutm%'
              OR LOWER(REPLACE(COALESCE(pci.MainMark, ''), CHAR(1), '')) LIKE '%boltm%'
              OR LOWER(REPLACE(COALESCE(pci.MainMark, ''), CHAR(1), '')) LIKE '%washerm%'
              OR LOWER(REPLACE(COALESCE(pci.PieceMark, ''), CHAR(1), '')) LIKE '%nutm%'
              OR LOWER(REPLACE(COALESCE(pci.PieceMark, ''), CHAR(1), '')) LIKE '%boltm%'
              OR LOWER(REPLACE(COALESCE(pci.PieceMark, ''), CHAR(1), '')) LIKE '%washerm%'
            )), 0) AS assemblyWeightEach,
        COALESCE((SELECT MAX(pca.AssemblyWeightEach * pca.AssemblyQuantity)
          FROM productioncontrolitems pci
          JOIN productioncontrolassemblies pca ON pca.ProductionControlAssemblyID = pci.ProductionControlAssemblyID
          WHERE pci.DrawingID = d.DrawingID
            AND pci.ProductionControlID = ?
            AND NOT (
              LOWER(REPLACE(COALESCE(pci.MainMark, ''), CHAR(1), '')) LIKE '%nutm%'
              OR LOWER(REPLACE(COALESCE(pci.MainMark, ''), CHAR(1), '')) LIKE '%boltm%'
              OR LOWER(REPLACE(COALESCE(pci.MainMark, ''), CHAR(1), '')) LIKE '%washerm%'
              OR LOWER(REPLACE(COALESCE(pci.PieceMark, ''), CHAR(1), '')) LIKE '%nutm%'
              OR LOWER(REPLACE(COALESCE(pci.PieceMark, ''), CHAR(1), '')) LIKE '%boltm%'
              OR LOWER(REPLACE(COALESCE(pci.PieceMark, ''), CHAR(1), '')) LIKE '%washerm%'
            )), 0) AS weight,
        COALESCE((SELECT MIN(pcs.SequenceID)
          FROM productioncontrolitems pci
          JOIN productioncontrolsequences pcs ON pcs.ProductionControlID = pci.ProductionControlID
          WHERE pci.DrawingID = d.DrawingID
            AND pci.ProductionControlID = ?
            AND NOT (
              LOWER(REPLACE(COALESCE(pci.MainMark, ''), CHAR(1), '')) LIKE '%nutm%'
              OR LOWER(REPLACE(COALESCE(pci.MainMark, ''), CHAR(1), '')) LIKE '%boltm%'
              OR LOWER(REPLACE(COALESCE(pci.MainMark, ''), CHAR(1), '')) LIKE '%washerm%'
              OR LOWER(REPLACE(COALESCE(pci.PieceMark, ''), CHAR(1), '')) LIKE '%nutm%'
              OR LOWER(REPLACE(COALESCE(pci.PieceMark, ''), CHAR(1), '')) LIKE '%boltm%'
              OR LOWER(REPLACE(COALESCE(pci.PieceMark, ''), CHAR(1), '')) LIKE '%washerm%'
            )), '—') AS sequence
      FROM drawings d
      LEFT JOIN drawingrevisions dr ON dr.DrawingRevisionID = d.LatestDrawingRevisionID
      LEFT JOIN approvalstatuses aps ON aps.ApprovalStatusID = d.ApprovalStatusID
      LEFT JOIN productioncontroljobs pcj ON pcj.ProductionControlID = ?
      WHERE d.ProjectID = ?
      ORDER BY d.DrawingNumber
      LIMIT 2000`,
      [productionControlId, productionControlId, productionControlId, productionControlId, productionControlId, Number(project.ProjectID)]
    );

    response.json({
      jobNumber: project.JobNumber,
      drawings: (drawingRows as Array<Record<string, any>>).map((drawing) => ({
        drawingId: Number(drawing.DrawingID),
        drawingNumber: cleanPowerFabValue(drawing.DrawingNumber),
        comment2: cleanPowerFabValue(drawing.comment2 || project.JobNumber),
        drawingLog: 'Drawing',
        revision: cleanPowerFabValue(drawing.revision),
        description: cleanPowerFabValue(drawing.Description),
        approvalStatus: cleanPowerFabValue(drawing.approvalStatus),
        assemblyQuantity: Number(drawing.assemblyQuantity ?? 0),
        assemblyWeightEach: Number(drawing.assemblyWeightEach ?? 0),
        assemblyWeight: Number(drawing.weight ?? 0),
        weight: Number(drawing.weight ?? 0),
        sequence: drawing.sequence ?? '—'
      }))
    });
  } catch (error) {
    console.error('Unable to load project drawings', error);
    response.status(500).json({ error: 'Failed to load project drawings from PowerFab.' });
  }
});

async function getAuthorizedProject(request: express.Request, response: express.Response) {
  const contractorId = getContractorId(request);
  const jobNumber = String(request.query.job || '').trim();
  if (!contractorId) {
    response.status(401).json({ error: 'Contractor login required.' });
    return null;
  }
  if (!jobNumber || !(await contractorCanAccessJob(contractorId, jobNumber))) {
    response.status(403).json({ error: 'Project is not assigned to this contractor.' });
    return null;
  }
  const [rows] = await mysqlConnection.query('SELECT ProjectID, JobNumber, JobDescription FROM projects WHERE JobNumber = ? LIMIT 1', [jobNumber]);
  const project = (rows as Array<Record<string, any>>)[0];
  if (!project) {
    response.status(404).json({ error: 'Project not found.' });
    return null;
  }
  return { contractorId, jobNumber, project };
}

app.get('/api/project-transmittals', async (request, response) => {
  const context = await getAuthorizedProject(request, response);
  if (!context) return;
  const [rows] = await mysqlConnection.query(
    `SELECT t.TransmittalID, t.TransmittalNumber, t.TransmittalDate, t.Title, t.Sending,
            t.Attn, t.SentBy, t.CopyTo, t.Remarks, t.NumberOfDrawings,
            t.NumberOfOutstandingDrawings, t.LastDateReceived, t.ReturnDate,
            COALESCE(f.Name, '—') AS firmName
     FROM transmittals t
     LEFT JOIN firms f ON f.FirmID = t.FirmID
     WHERE t.ProjectID = ?
     ORDER BY t.TransmittalDate DESC, t.TransmittalID DESC`,
    [Number(context.project.ProjectID)]
  );
  response.json({ jobNumber: context.jobNumber, transmittals: rows });
});

app.get('/api/transmittal-drawings', async (request, response) => {
  const context = await getAuthorizedProject(request, response);
  if (!context) return;
  const transmittalId = Number(request.query.transmittal || 0);
  if (!Number.isInteger(transmittalId) || transmittalId <= 0) return response.status(400).json({ error: 'transmittal query parameter is required' });

  try {
    const productionControlId = Number(await getSingleValue('SELECT ProductionControlID FROM productioncontroljobs WHERE JobNumber = ? LIMIT 1', [context.jobNumber]));
    const [drawingRows] = await mysqlConnection.query(
            `SELECT DISTINCT d.DrawingID, d.DrawingNumber, d.Description,
              (SELECT pcj.Comment2 FROM productioncontroljobs pcj WHERE pcj.ProductionControlID = ? LIMIT 1) AS comment2,
              COALESCE(dr.Revision, '—') AS revision,
              COALESCE(aps.Description, '—') AS approvalStatus,
              (SELECT MIN(pca.ProductionControlAssemblyID)
               FROM productioncontrolitems pci
               JOIN productioncontrolassemblies pca
                 ON pca.ProductionControlID = pci.ProductionControlID
                AND pca.ProductionControlAssemblyID = pci.ProductionControlAssemblyID
               WHERE pci.DrawingID = d.DrawingID
                 AND pci.ProductionControlID = ?) AS productionControlAssemblyID
              ,(SELECT pca.MainMark FROM productioncontrolassemblies pca WHERE pca.ProductionControlID = ? AND pca.ProductionControlAssemblyID = (SELECT MIN(pci2.ProductionControlAssemblyID) FROM productioncontrolitems pci2 WHERE pci2.DrawingID = d.DrawingID AND pci2.ProductionControlID = ?)) AS assemblyMark
              ,(SELECT pca.AssemblyQuantity FROM productioncontrolassemblies pca WHERE pca.ProductionControlID = ? AND pca.ProductionControlAssemblyID = (SELECT MIN(pci3.ProductionControlAssemblyID) FROM productioncontrolitems pci3 WHERE pci3.DrawingID = d.DrawingID AND pci3.ProductionControlID = ?)) AS assemblyQuantity
       FROM drawingtransmittals dt
       JOIN transmittals t ON t.TransmittalID = dt.TransmittalID
       JOIN drawings d ON d.DrawingID = dt.DrawingID
       LEFT JOIN drawingrevisions dr ON dr.DrawingRevisionID = COALESCE(dt.DrawingRevisionID, d.LatestDrawingRevisionID)
       LEFT JOIN approvalstatuses aps ON aps.ApprovalStatusID = d.ApprovalStatusID
       WHERE dt.TransmittalID = ? AND t.ProjectID = ?
       ORDER BY d.DrawingNumber
       LIMIT 2000`,
      [productionControlId, productionControlId, productionControlId, productionControlId, productionControlId, productionControlId, transmittalId, Number(context.project.ProjectID)]
    );

    response.json({
      jobNumber: context.jobNumber,
      transmittalId,
      drawings: (drawingRows as Array<Record<string, any>>).flatMap((drawing) => {
        const assemblyId = drawing.productionControlAssemblyID ? Number(drawing.productionControlAssemblyID) : 0;
        const assemblyMark = cleanPowerFabValue(drawing.assemblyMark || drawing.DrawingNumber);
        const comment2 = cleanPowerFabValue(drawing.comment2 || context.jobNumber);
        const drawingMark = `${comment2}-${assemblyMark}`;
        const quantity = Math.max(1, Number(drawing.assemblyQuantity ?? 1));
        return Array.from({ length: assemblyId ? quantity : 1 }, (_value, index) => {
          const instanceNumber = assemblyId ? index + 1 : null;
          const qrCode = assemblyId
            ? buildAssemblyQrCode(context.jobNumber, `${assemblyId}-${instanceNumber}`)
            : '';
          const instanceMark = instanceNumber ? buildAssemblyInstanceMark(comment2, assemblyMark, instanceNumber) : drawingMark;
          return {
        drawingId: Number(drawing.DrawingID),
        rowKey: `${Number(drawing.DrawingID)}-${instanceNumber ?? 0}`,
        drawingNumber: drawingMark,
        instanceMark,
        instanceNumber,
        description: cleanPowerFabValue(drawing.Description),
        revision: cleanPowerFabValue(drawing.revision),
        approvalStatus: cleanPowerFabValue(drawing.approvalStatus),
        qrCode,
        qrUrl: assemblyId
          ? `/api/assemblies/${encodeURIComponent(qrCode)}/qr?workflow=inspection`
          : `/api/drawings/${Number(drawing.DrawingID)}/qr?job=${encodeURIComponent(context.jobNumber)}`,
        qrType: assemblyId ? 'assembly' : 'drawing'
          };
        });
      })
    });
  } catch (error) {
    console.error('Unable to load transmittal drawings', error);
    response.status(500).json({ error: 'Failed to load drawings assigned to this transmittal.' });
  }
});

app.get('/api/project-inspections', async (request, response) => {
  const context = await getAuthorizedProject(request, response);
  if (!context) return;
  const productionControlId = await getSingleValue('SELECT ProductionControlID FROM productioncontroljobs WHERE JobNumber = ? LIMIT 1', [context.jobNumber]);
  await reconcileFitupInspectionStatus(Number(productionControlId));
  const [powerFabRows] = await mysqlConnection.query(
    `SELECT itr.InspectionTestRecordID, itr.InspectionTestID, itr.TestDateTime, itr.TestUpdatedDateTime,
            itr.TestFailed, itr.Quantity, it.InspectionTestID,
            COALESCE(itt.Description, 'Inspection') AS inspectionType,
            pis.MainMark, pis.PieceMark
     FROM inspectiontestrecords itr
     LEFT JOIN inspectiontests it ON it.InspectionTestID = itr.InspectionTestID
     LEFT JOIN inspectiontesttypes itt ON itt.InspectionTestTypeID = it.InspectionTestTypeID
     LEFT JOIN productioncontrolitemstations pis ON pis.ProductionControlItemStationID = itr.ProductionControlItemStationID
     WHERE pis.ProductionControlID = ?
     ORDER BY itr.TestDateTime DESC
     LIMIT 1000`,
    [productionControlId]
  );
  const [portalRows] = await mysqlConnection.query(
    `SELECT id, qrCode, assemblyMark, inspectionType, result, inspector, remarks, checks, createdAt
     FROM contractor_fitup_inspections WHERE jobNumber = ? ORDER BY createdAt DESC LIMIT 1000`,
    [context.jobNumber]
  );
  response.json({ jobNumber: context.jobNumber, powerFabInspections: powerFabRows, contractorInspections: portalRows });
});

app.get('/api/project-production-status', async (request, response) => {
  const context = await getAuthorizedProject(request, response);
  if (!context) return;
  try {
    const productionControlId = await getSingleValue('SELECT ProductionControlID FROM productioncontroljobs WHERE JobNumber = ? LIMIT 1', [context.jobNumber]);
    await reconcileFitupInspectionStatus(Number(productionControlId));
    const [stationRows] = await mysqlConnection.query(
      `SELECT StationID, Description, StationNumber
       FROM stations
       WHERE StationID > 0
       ORDER BY StationNumber, StationID`
    );
    const stations = (stationRows as Array<Record<string, any>>).map(row => ({
      stationId: Number(row.StationID),
      description: cleanPowerFabValue(row.Description || 'Station'),
      stationNumber: Number(row.StationNumber || 0)
    }));
    const [assemblyRows] = await mysqlConnection.query(
            `SELECT ProductionControlAssemblyID, REPLACE(MainMark, CHAR(1), '') AS mainMark,
              AssemblyQuantity, AssemblyWeightEach,
              (SELECT MIN(pci.DrawingNumber) FROM productioncontrolitems pci
               WHERE pci.ProductionControlID = productioncontrolassemblies.ProductionControlID
           AND pci.ProductionControlAssemblyID = productioncontrolassemblies.ProductionControlAssemblyID) AS drawingNumber
       FROM productioncontrolassemblies
       WHERE ProductionControlID = ?
       ORDER BY MainMark, ProductionControlAssemblyID`,
      [productionControlId]
    );
    const [summaryRows] = await mysqlConnection.query(
      `SELECT s.ProductionControlItemID, s.StationID, s.TotalQuantity, s.QuantityCompleted,
              pci.ProductionControlAssemblyID
       FROM productioncontrolitemstationsummary s
       JOIN productioncontrolitems pci ON pci.ProductionControlItemID = s.ProductionControlItemID
       WHERE s.ProductionControlID = ?`,
      [productionControlId]
    );
    const summaries = new Map<string, { total: number; completed: number }>();
    for (const row of summaryRows as Array<Record<string, any>>) {
      summaries.set(`${row.ProductionControlAssemblyID}:${row.StationID}`, {
        total: Number(row.TotalQuantity || 0),
        completed: Number(row.QuantityCompleted || 0)
      });
    }
    const assemblies = (assemblyRows as Array<Record<string, any>>).map(row => ({
      assemblyId: Number(row.ProductionControlAssemblyID),
      drawingNumber: cleanPowerFabValue(row.drawingNumber || row.mainMark || ''),
      mainMark: cleanPowerFabValue(row.mainMark || ''),
      quantity: Number(row.AssemblyQuantity || 0),
      weight: Number(row.AssemblyWeightEach || 0),
      stations: stations.map(station => summaries.get(`${row.ProductionControlAssemblyID}:${station.stationId}`) || { total: Number(row.AssemblyQuantity || 0), completed: 0, stationName: station.description })
        .map((status, index) => ({ ...status, stationName: stations[index].description }))
    }));
    response.json({ jobNumber: context.jobNumber, productionControlId, stations, assemblies });
  } catch (error) {
    console.error('Unable to load project production status', error);
    response.status(500).json({ error: 'Unable to load production status from PowerFab.' });
  }
});

app.get('/api/drawings/:drawingId/pdf', async (request, response) => {
  const drawingId = Number(request.params.drawingId);
  if (!Number.isInteger(drawingId) || drawingId <= 0) return response.status(400).send('Invalid drawing ID');
  if (!drawingsRoot) return response.status(404).send('Drawing PDF folder is not configured. Set POWERFAB_DRAWINGS_ROOT in .env.');

  const [rows] = await mysqlConnection.query(
    `SELECT d.DrawingNumber, dl.SubdirectoryPath
     FROM drawings d
     LEFT JOIN drawinglogs dl ON dl.DrawingLogID = d.DrawingLogID
     WHERE d.DrawingID = ? LIMIT 1`,
    [drawingId]
  );
  const drawing = (rows as Array<Record<string, any>>)[0];
  if (!drawing) return response.status(404).send('Drawing not found');

  const drawingNumber = String(drawing.DrawingNumber ?? '').replace(/[^A-Za-z0-9_.-]/g, '');
  const relativeFolder = String(drawing.SubdirectoryPath ?? '').replace(/[\\/]+/g, '/').replace(/^\/+|\.\.+/g, '');
  const root = resolve(drawingsRoot);
  const directCandidates = [
    resolve(join(root, relativeFolder, `${drawingNumber}.pdf`)),
    resolve(join(root, `${drawingNumber}.pdf`))
  ];
  const filePath = directCandidates.find((candidate) => candidate.startsWith(root) && existsSync(candidate))
    ?? findDrawingPdf(root, `${drawingNumber}.pdf`);
  if (!filePath) return response.status(404).send(`PDF not found for drawing ${drawingNumber}`);
  response.sendFile(filePath);
});

app.get('/api/drawings/:drawingId/qr', async (request, response) => {
  const drawingId = Number(request.params.drawingId);
  const jobNumber = String(request.query.job || '').trim();
  if (!Number.isInteger(drawingId) || drawingId <= 0 || !jobNumber) return response.status(400).send('Drawing ID and job are required');

  try {
    const [rows] = await mysqlConnection.query('SELECT DrawingNumber FROM drawings WHERE DrawingID = ? LIMIT 1', [drawingId]);
    const drawing = (rows as Array<Record<string, any>>)[0];
    if (!drawing) return response.status(404).send('Drawing not found');
    const scanUrl = `${publicAppUrl}/drawings.html?job=${encodeURIComponent(jobNumber)}&drawing=${encodeURIComponent(String(drawingId))}`;
    const png = await QRCode.toBuffer(scanUrl, { type: 'png', width: 600, margin: 2, errorCorrectionLevel: 'H' });
    response.type('png').send(png);
  } catch (error) {
    console.error('Unable to render drawing QR code', error);
    response.status(500).send('Unable to render drawing QR code');
  }
});

app.get('/api/assemblies/:qrCode/qr', async (request, response) => {
  const qrCode = String(request.params.qrCode || '').trim();
  if (!qrCode) return response.status(400).send('QR code is required');

  try {
    const scanPage = request.query.workflow === 'inspection' ? '/inspection.html' : '/scan.html';
    const scanUrl = `${publicAppUrl}${scanPage}?qr=${encodeURIComponent(qrCode)}`;
    const png = await QRCode.toBuffer(scanUrl, { type: 'png', width: 600, margin: 2, errorCorrectionLevel: 'H' });
    response.type('png').send(png);
  } catch (error) {
    console.error('Unable to render assembly QR code', error);
    response.status(500).send('Unable to render assembly QR code');
  }
});

app.get('/api/assemblies/:qrCode/status', async (request, response) => {
  const qrCode = normalizeAssemblyQrCode(request.params.qrCode);
  if (!qrCode) return response.status(400).json({ error: 'QR code is required' });
  const contractorId = getContractorId(request);
  if (!contractorId) return response.status(401).json({ error: 'Contractor login required.' });
  if (!(await contractorCanAccessQr(contractorId, qrCode))) return response.status(403).json({ error: 'Assembly is not assigned to this contractor.' });
  const inspectionRole = await getFitupInspectionRole(contractorId);
  if (!inspectionRole) return response.status(403).json({ error: 'Inspection permission is not granted in PowerFab.' });
  const [contractorRows] = await mysqlConnection.query('SELECT username, contractorName FROM contractor_users WHERE id = ? LIMIT 1', [contractorId]);
  const contractor = (contractorRows as Array<Record<string, any>>)[0] ?? {};
  const assignedContractor = contractor.contractorName ?? '';

  const [rows] = await mysqlConnection.query(
    'SELECT * FROM `assembly_scan_history` WHERE `qrCode` = ? ORDER BY `createdAt` DESC',
    [qrCode]
  );
  const history = (rows as Array<Record<string, any>>).map((row) => ({
    qrCode,
    jobNumber: row.jobNumber,
    assemblyMark: row.assemblyMark,
    stage: row.stageName,
    stationName: row.stationName,
    routeName: row.routeName,
    scannedBy: row.scannedBy,
    note: row.note,
    createdAt: row.createdAt
  }));

  const [stationRows] = await mysqlConnection.query(
    'SELECT * FROM `assembly_station_updates` WHERE `qrCode` = ? ORDER BY `createdAt` DESC, `id` DESC LIMIT 1',
    [qrCode]
  );
  const stationRow = (stationRows as Array<Record<string, any>>)[0] ?? null;

  const assemblyMatch = await findAssemblyRecordByQrCode(qrCode);
  const assemblyDrawing = assemblyMatch ? await getAssemblyDrawing(assemblyMatch.productionControlID, assemblyMatch.productionControlAssemblyID) : null;
  const [projectRows] = await mysqlConnection.query(
    `SELECT p.JobDescription, pcj.Comment2
     FROM projects p
     LEFT JOIN productioncontroljobs pcj ON pcj.JobNumber = p.JobNumber
     WHERE p.JobNumber = ?
     LIMIT 1`,
    [assemblyMatch?.jobNumber || history[0]?.jobNumber || '']
  );
  const projectData = (projectRows as Array<Record<string, any>>)[0] ?? {};
  const jobNumber = String(assemblyMatch?.jobNumber || history[0]?.jobNumber || '');
  const assemblyMark = assemblyMatch?.assemblyMark || history[0]?.assemblyMark || '';
  const drawingNumber = projectData.Comment2 && assemblyMark ? `${cleanPowerFabValue(projectData.Comment2)}-${assemblyMark}` : cleanPowerFabValue(assemblyDrawing?.DrawingNumber);
  const instanceMark = assemblyMatch?.instanceNumber ? `${drawingNumber}-${assemblyMatch.instanceNumber}` : drawingNumber;
  const currentStage = history[0]?.stage ?? 'Fitup';
  response.json({
    qrCode,
    currentStage,
    jobNumber,
    jobDescription: cleanPowerFabValue(projectData.JobDescription),
    assemblyMark,
    drawingNumber,
    instanceMark,
    instanceNumber: assemblyMatch?.instanceNumber ?? null,
    assemblyWeight: assemblyMatch?.assemblyWeightEach ?? 0,
    contractorName: assignedContractor,
    drawingId: assemblyDrawing ? Number(assemblyDrawing.DrawingID) : null,
    availableInstanceNumbers: assemblyMatch ? await getAvailableAssemblyInstanceNumbers(assemblyMatch) : [],
    stationData: stationRow ? {
      mainMark: stationRow.mainMark,
      pieceMark: stationRow.pieceMark,
      sequenceValue: stationRow.sequenceValue,
      lotNumber: stationRow.lotNumber,
      quantity: stationRow.quantity === null ? null : Number(stationRow.quantity),
      instanceNumber: stationRow.instanceNumber,
      app: stationRow.app,
      inspectionFailures: stationRow.inspectionFailures === null ? null : Number(stationRow.inspectionFailures),
      completedBy: stationRow.completedBy,
      hours: stationRow.hours === null ? null : Number(stationRow.hours),
      minutes: stationRow.minutes === null ? null : Number(stationRow.minutes),
      batchId: stationRow.batchId,
      workArea: stationRow.workArea,
      weight: stationRow.weight,
      finish: stationRow.finish,
      nextStation: stationRow.nextStation,
      remark: stationRow.remark,
      includeIfPreviousStationNotCompleted: Boolean(stationRow.includeIfPreviousStationNotCompleted)
    } : null,
    productionControlAssemblyID: assemblyMatch?.productionControlAssemblyID ?? null,
    assemblyQuantity: assemblyMatch?.assemblyQuantity ?? 0,
    assemblyWeightEach: assemblyMatch?.assemblyWeightEach ?? 0,
    inspectionFields: await getInspectionFields(await getInspectionTestId(inspectionRole)),
    inspectionLocations: await getInspectionLocations(),
    inspector: {
      username: String(contractor.username ?? ''),
      name: String(contractor.username ?? ''),
      ...(await getProjectInspectorContact(jobNumber, String(contractor.username ?? '')))
    },
    inspectionRole,
    history
  });
});

async function getAssemblyInstanceNumbers(productionControlID: number, productionControlAssemblyID: number) {
  const [rows] = await mysqlConnection.query(
    `SELECT DISTINCT pin.InstanceNumber
     FROM productioncontroliteminstancenumbers pin
     JOIN productioncontrolitems pci ON pci.ProductionControlItemID = pin.ProductionControlItemID
     WHERE pci.ProductionControlID = ?
       AND pci.ProductionControlAssemblyID = ?
       AND pin.InstanceNumber IS NOT NULL
     ORDER BY pin.InstanceNumber`,
    [productionControlID, productionControlAssemblyID]
  );
  return (rows as Array<Record<string, any>>).map((row) => Number(row.InstanceNumber)).filter((value) => Number.isFinite(value));
}

function buildInstanceNumberRange(quantity: number) {
  const total = Math.max(0, Math.floor(Number(quantity) || 0));
  return Array.from({ length: total }, (_value, index) => index + 1);
}

function parseInspectionInstanceNumbers(checks: Record<string, unknown>) {
  return String(checks.instanceNumber ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value, index, values) => Number.isInteger(value) && value > 0 && values.indexOf(value) === index);
}

async function getAvailableAssemblyInstanceNumbers(assembly: Record<string, any>) {
  const instanceNumbers = await getAssemblyInstanceNumbers(assembly.productionControlID, assembly.productionControlAssemblyID);
  return instanceNumbers.length ? instanceNumbers : buildInstanceNumberRange(Number(assembly.assemblyQuantity ?? 0));
}

function inspectionFieldKey(fieldName: string) {
  return fieldName.toLowerCase().replace(/[^a-z0-9]+(.)/g, (_match, character) => String(character).toUpperCase());
}

async function getInspectionFields(inspectionTestId: number) {
  const [rows] = await mysqlConnection.query(
    `SELECT f.*, f.InspectionTestFieldID, s.String AS fieldName, os.String AS optionValue
     FROM inspectiontestfields f
     JOIN inspectionteststrings s ON s.InspectionTestStringID = f.FieldNameStringID
     LEFT JOIN inspectiontestfieldoptions o ON o.InspectionTestFieldID = f.InspectionTestFieldID
     LEFT JOIN inspectionteststrings os ON os.InspectionTestStringID = o.OptionStringID
     WHERE f.InspectionTestID = ?
     ORDER BY f.FieldIndex, o.InspectionTestFieldOptionID`,
    [inspectionTestId]
  );
  return (rows as Array<Record<string, any>>).reduce<Array<{ id: number; name: string; key: string; type: string; options: string[] }>>((fields, row) => {
    const fieldName = String(row.fieldName || '').trim();
    if (!fieldName) return fields;
    const fieldId = Number(row.InspectionTestFieldID);
    let field = fields.find((item) => item.id === fieldId);
    if (!field) {
      const fieldType = String(row.Type ?? row.FieldType ?? row.DataType ?? '').toLowerCase();
      field = { id: fieldId, name: fieldName, key: inspectionFieldKey(fieldName), type: fieldType, options: [] };
      fields.push(field);
    }
    if (row.optionValue !== null && row.optionValue !== undefined && !field.options.includes(String(row.optionValue))) {
      field.options.push(String(row.optionValue));
    }
    return fields;
  }, []);
}

async function getAssemblyDrawing(productionControlID: number, productionControlAssemblyID: number) {
  const [rows] = await mysqlConnection.query(
    `SELECT d.DrawingID, d.DrawingNumber
     FROM productioncontrolitems pci
     JOIN drawings d ON d.DrawingID = pci.DrawingID
     WHERE pci.ProductionControlID = ? AND pci.ProductionControlAssemblyID = ?
     ORDER BY pci.ProductionControlItemID LIMIT 1`,
    [productionControlID, productionControlAssemblyID]
  );
  return (rows as Array<Record<string, any>>)[0] ?? null;
}

async function syncInspectionToPowerFab(assembly: Record<string, any>, inspection: z.infer<typeof fitupInspectionInput>, inspectionType: InspectionType, contractorId: number) {
  const checks = inspection.checks ?? {};
  const instanceNumbers = String(checks.instanceNumber ?? '').split(',').map((value) => Number(value.trim())).filter((value, index, values) => value > 0 && values.indexOf(value) === index);
  const productionControlID = Number(assembly.productionControlID ?? 0);
  const productionControlAssemblyID = Number(assembly.productionControlAssemblyID ?? 0);
  const inspectionTestId = await getInspectionTestId(inspectionType);
  if (!productionControlID || !productionControlAssemblyID) return;

  const [configuredTestRows] = await mysqlConnection.query(
    'SELECT StationID FROM inspectiontests WHERE InspectionTestID = ? LIMIT 1',
    [inspectionTestId]
  );
  const inspectionStationId = Number((configuredTestRows as Array<Record<string, any>>)[0]?.StationID ?? (inspectionType === 'CLIENT_FITUP' ? 7 : inspectionType === 'PAINTING_INSPECTION' ? 9 : 6));
  const [versionRows] = await mysqlConnection.query(
    `SELECT InspectionTestVersionID
     FROM inspectiontestversions
     WHERE InspectionTestID = ?
     ORDER BY VersionDateTime DESC, InspectionTestVersionID DESC
     LIMIT 1`,
    [inspectionTestId]
  );
  const inspectionTestVersionId = Number((versionRows as Array<Record<string, any>>)[0]?.InspectionTestVersionID ?? (inspectionType === 'CLIENT_FITUP' ? 5 : inspectionType === 'PAINTING_INSPECTION' ? 6 : 3));
  const [contractorRows] = await mysqlConnection.query('SELECT username FROM contractor_users WHERE id=? LIMIT 1', [contractorId]);
  const username = String((contractorRows as Array<Record<string, any>>)[0]?.username ?? '');
  const inspectorContact = await getProjectInspectorContact(String(assembly.jobNumber), username);
  const locationId = Number(inspection.checks?.inspectionLocationId ?? 0) || Number((await getInspectionLocations())[0]?.id ?? 0);

  const [stationRows] = await mysqlConnection.query(
    `SELECT ProductionControlItemStationID, Quantity
     FROM productioncontrolitemstations
    WHERE ProductionControlID = ? AND StationID = ? AND REPLACE(MainMark, CHAR(1), '') = ?
     ORDER BY ProductionControlItemStationID DESC LIMIT 1`,
    [productionControlID, inspectionStationId, assembly.assemblyMark]
  );
  let station = (stationRows as Array<Record<string, any>>)[0];
  const [itemRows] = await mysqlConnection.query(
    `SELECT ProductionControlItemID
     FROM productioncontrolitems
     WHERE ProductionControlID = ? AND ProductionControlAssemblyID = ?
     ORDER BY ProductionControlItemID LIMIT 1`,
    [productionControlID, productionControlAssemblyID]
  );
  const item = (itemRows as Array<Record<string, any>>)[0];
  if (!item) return;
  if (!station) {
    const [stationResult] = await mysqlConnection.query(
      `INSERT INTO productioncontrolitemstations
       (ProductionControlID, MainMark, PieceMark, SequenceID, StationID, Quantity, UserID, DateCompleted, TimeCompleted, Hours, BatchID)
       VALUES (?, ?, ?, 0, ?, ?, 0, CURDATE(), CURTIME(), 0, ?)`,
      [productionControlID, assembly.assemblyMark, assembly.assemblyMark, inspectionStationId, Number(assembly.assemblyQuantity || 1), `${assembly.jobNumber}-${assembly.assemblyMark}`]
    );
    station = { ProductionControlItemStationID: Number((stationResult as any).insertId), Quantity: Number(assembly.assemblyQuantity || 1) };
  }

  const [subtypeResult] = await mysqlConnection.query(
    `INSERT INTO inspectiontestsubtypes
     (ProductionControlID, JobNumber, MainMark, PieceMark, SequenceID, Sequence, LotNumber, WorkPackageID, WorkPackageNumber, LoadNumber, UserID)
     VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?, NULL, NULL)`,
    [
      productionControlID,
      String(checks.jobNumber || assembly.jobNumber),
      String(checks.mainMark || assembly.assemblyMark),
      String(checks.pieceMark || assembly.assemblyMark),
      String(checks.sequence || ''),
      String(checks.lotNumber || ''),
      String(checks.workPackage || '')
    ]
  );
  const inspectionTestSubTypeID = Number((subtypeResult as any).insertId);
  const [instanceStringResult] = await mysqlConnection.query(
    'INSERT INTO inspectionteststrings (String) VALUES (?)',
    [instanceNumbers.join(',')]
  );
  const instanceNumberStringID = Number((instanceStringResult as any).insertId);

  const testDate = parseIndiaDateTime(checks.testPerformed);
  const [recordResult] = await mysqlConnection.query(
    `INSERT INTO inspectiontestrecords (
      InspectionTestID, InspectionTestVersionID, InspectionTestSubTypeID, Quantity, TestHours, TestDateTime,
      InspectorFirmContactID, TestUpdatedDateTime, InspectionTestLocationID, TestFailed,
      ProductionControlItemStationID, ProductionControlItemStationQuantity, InstanceNumberStringID, UpdateCount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      inspectionTestId,
      inspectionTestVersionId,
      inspectionTestSubTypeID,
      instanceNumbers.length || Number(checks.quantity || station.Quantity || 1),
      Number(checks.testHours || 0),
      testDate,
      inspectorContact?.contactId ?? null,
      new Date(),
      locationId,
      inspection.result !== 'PASS' ? 1 : 0,
      Number(station.ProductionControlItemStationID),
      instanceNumbers.length || Number(checks.quantity || station.Quantity || 1),
      instanceNumberStringID
    ]
  );
  const inspectionTestRecordID = Number((recordResult as any).insertId);
  await mysqlConnection.query(
    `UPDATE inspectiontests
     SET LastInspectionTestRecordID = ?, LastInspectionTestRecordDateTime = ?, UpdateCount = UpdateCount + 1
     WHERE InspectionTestID = ?`,
    [inspectionTestRecordID, testDate, inspectionTestId]
  );
  await mysqlConnection.query(
    `UPDATE inspectiontestversions
     SET LastInspectionTestRecordID = ?, LastInspectionTestRecordDateTime = ?
     WHERE InspectionTestVersionID = ?`,
    [inspectionTestRecordID, testDate, inspectionTestVersionId]
  );

  const inspectionFields = await getInspectionFields(inspectionTestId);
  const fieldValues = inspectionFields
    .map((field) => [field.id, checks[field.key]] as [number, unknown])
    .filter(([, value]) => value !== undefined && String(value).trim() !== '');
  for (const [inspectionTestFieldID, value] of fieldValues) {
    const [stringResult] = await mysqlConnection.query(
      'INSERT INTO inspectionteststrings (String) VALUES (?)',
      [String(value)]
    );
    const [fieldResult] = await mysqlConnection.query(
      `INSERT INTO inspectiontestrecordfields
       (InspectionTestRecordID, InspectionTestFieldID, FieldInstance, ValueStringID, IndicatesFailure)
       VALUES (?, ?, 1, ?, 0)`,
      [inspectionTestRecordID, inspectionTestFieldID, Number((stringResult as any).insertId)]
    );
    void fieldResult;
  }

  for (const instanceNumber of instanceNumbers) {
    await mysqlConnection.query(
      `INSERT INTO inspectiontestrecordinstancenumbers
       (InspectionTestRecordID, ProductionControlItemID, InstanceNumber)
       VALUES (?, ?, ?)`,
      [inspectionTestRecordID, Number(item.ProductionControlItemID), instanceNumber]
    );
  }
}

async function getPowerFabInspectionHistory(assembly: Record<string, any>) {
  const [rows] = await mysqlConnection.query(
    `SELECT itr.InspectionTestRecordID, itr.InspectionTestID, itr.TestDateTime, itr.TestUpdatedDateTime,
            itr.TestFailed, itr.Quantity, pis.MainMark, pis.PieceMark
     FROM inspectiontestrecords itr
     JOIN productioncontrolitemstations pis
       ON pis.ProductionControlItemStationID = itr.ProductionControlItemStationID
     WHERE pis.ProductionControlID = ?
       AND (
         REPLACE(pis.MainMark, CHAR(1), '') = ?
         OR EXISTS (
           SELECT 1
           FROM productioncontrolitems pci
           WHERE pci.ProductionControlID = pis.ProductionControlID
             AND pci.ProductionControlAssemblyID = ?
             AND (
               REPLACE(pci.MainMark, CHAR(1), '') = REPLACE(pis.MainMark, CHAR(1), '')
               OR REPLACE(pci.PieceMark, CHAR(1), '') = REPLACE(pis.MainMark, CHAR(1), '')
               OR REPLACE(pci.MainMark, CHAR(1), '') = REPLACE(pis.PieceMark, CHAR(1), '')
               OR REPLACE(pci.PieceMark, CHAR(1), '') = REPLACE(pis.PieceMark, CHAR(1), '')
             )
         )
       )
     ORDER BY itr.TestDateTime DESC, itr.InspectionTestRecordID DESC`,
    [
      Number(assembly.productionControlID ?? 0),
      String(assembly.assemblyMark ?? ''),
      Number(assembly.productionControlAssemblyID ?? 0)
    ]
  );

  const records = rows as Array<Record<string, any>>;
  const recordIds = records.map((row) => Number(row.InspectionTestRecordID)).filter((id) => id > 0);
  const instanceNumbersByRecord = new Map<number, number[]>();
  if (recordIds.length) {
    const placeholders = recordIds.map(() => '?').join(',');
    const [instanceRows] = await mysqlConnection.query(
      `SELECT InspectionTestRecordID, InstanceNumber
       FROM inspectiontestrecordinstancenumbers
       WHERE InspectionTestRecordID IN (${placeholders})
       ORDER BY InspectionTestRecordID, InstanceNumber`,
      recordIds
    );
    for (const row of instanceRows as Array<Record<string, any>>) {
      const recordId = Number(row.InspectionTestRecordID);
      const instanceNumber = Number(row.InstanceNumber);
      if (!Number.isFinite(instanceNumber)) continue;
      const numbers = instanceNumbersByRecord.get(recordId) ?? [];
      numbers.push(instanceNumber);
      instanceNumbersByRecord.set(recordId, numbers);
    }
  }

  return records.map((row) => {
    const recordId = Number(row.InspectionTestRecordID);
    const instanceNumbers = instanceNumbersByRecord.get(recordId) ?? [];
    return {
      id: `powerfab-${recordId}`,
      inspectionTestId: Number(row.InspectionTestID ?? 0),
      result: Number(row.TestFailed ?? 0) ? 'FAIL' : 'PASS',
      inspector: 'PowerFab',
      remarks: 'Historical PowerFab inspection record',
      checks: { instanceNumber: instanceNumbers.join(', '), quantity: Number(row.Quantity ?? 0) },
      createdAt: row.TestDateTime ?? row.TestUpdatedDateTime,
      source: 'PowerFab',
      powerFabRecordId: recordId
    };
  });
}

async function hasCompletedVendorFitup(assembly: Record<string, any>) {
  const availableInstanceNumbers = await getAvailableAssemblyInstanceNumbers(assembly);
  const targetInstanceNumber = Number(assembly.instanceNumber ?? 0);
  if (!availableInstanceNumbers.length && !targetInstanceNumber) return false;
  const [rows] = await mysqlConnection.query(
    'SELECT result, checks FROM contractor_fitup_inspections WHERE qrCode = ? AND inspectionType = ? ORDER BY createdAt DESC',
    [assembly.qrCode, 'VENDOR_FITUP']
  );
  const passedInstanceNumbers = new Set<number>();
  for (const row of rows as Array<Record<string, any>>) {
    if (row.result !== 'PASS') continue;
    let checks: Record<string, unknown> = {};
    try {
      checks = typeof row.checks === 'string' ? JSON.parse(row.checks) : (row.checks ?? {});
    } catch {
      checks = {};
    }
    parseInspectionInstanceNumbers(checks).forEach((value) => passedInstanceNumbers.add(value));
  }
  const powerFabInspections = await getPowerFabInspectionHistory(assembly);
  powerFabInspections
    .filter((inspection) => inspection.inspectionTestId === 1 && inspection.result === 'PASS')
    .forEach((inspection) => parseInspectionInstanceNumbers(inspection.checks).forEach((value) => passedInstanceNumbers.add(value)));
  return targetInstanceNumber > 0
    ? passedInstanceNumbers.has(targetInstanceNumber)
    : availableInstanceNumbers.every((value) => passedInstanceNumbers.has(value));
}

async function markAssemblyPieceTrackingComplete(assembly: Record<string, any>, checks: Record<string, unknown>, inspectionType: InspectionType) {
  const productionControlID = Number(assembly.productionControlID ?? 0);
  const productionControlAssemblyID = Number(assembly.productionControlAssemblyID ?? 0);
  if (!productionControlID || !productionControlAssemblyID) return;
  const stationId = inspectionType === 'CLIENT_FITUP' ? 7 : inspectionType === 'PAINTING_INSPECTION' ? 9 : 6;
  const instanceNumbers = String(checks.instanceNumber ?? '').split(',').map((value) => Number(value.trim())).filter((value, index, values) => value > 0 && values.indexOf(value) === index);
  if (instanceNumbers.length > 0) {
    const [itemRows] = await mysqlConnection.query(
      `SELECT ProductionControlItemID FROM productioncontrolitems
       WHERE ProductionControlID = ? AND ProductionControlAssemblyID = ? AND InstanceTracking = 3
       ORDER BY ProductionControlItemID LIMIT 1`,
      [productionControlID, productionControlAssemblyID]
    );
    const item = (itemRows as Array<Record<string, any>>)[0];
    if (!item) return;
    await mysqlConnection.query(
      `INSERT IGNORE INTO productioncontrolitemstationsummaryinstancenumbers
       (ProductionControlItemStationSummaryID, ProductionControlItemID, InstanceNumber, Completed, Hours, DateCompleted, HasFailedInspectionTest)
       SELECT s.ProductionControlItemStationSummaryID, ?, pin.InstanceNumber, 0, 0, NULL, 0
       FROM productioncontrolitemstationsummary s
       JOIN productioncontroliteminstancenumbers pin ON pin.ProductionControlItemID = ?
      WHERE s.ProductionControlID = ? AND s.ProductionControlItemID = ? AND s.StationID = ?`,
          [Number(item.ProductionControlItemID), Number(item.ProductionControlItemID), productionControlID, Number(item.ProductionControlItemID), stationId]
    );
    for (const instanceNumber of instanceNumbers) {
      await mysqlConnection.query(
        `UPDATE productioncontrolitemstationsummaryinstancenumbers si
         JOIN productioncontrolitemstationsummary s ON s.ProductionControlItemStationSummaryID = si.ProductionControlItemStationSummaryID
         SET si.Completed = 1, si.DateCompleted = CURDATE(), si.HasFailedInspectionTest = 0
         WHERE s.ProductionControlID = ? AND s.ProductionControlItemID = ? AND s.StationID = ? AND si.InstanceNumber = ?`,
        [productionControlID, Number(item.ProductionControlItemID), stationId, instanceNumber]
      );
    }
    await mysqlConnection.query(
      `UPDATE productioncontrolitemstationsummary s
       SET s.QuantityCompleted = (SELECT COUNT(*) FROM productioncontrolitemstationsummaryinstancenumbers si WHERE si.ProductionControlItemStationSummaryID = s.ProductionControlItemStationSummaryID AND si.Completed = 1),
           s.LastDateCompleted = CURDATE(), s.FailedInspectionTestQuantity = 0
      WHERE s.ProductionControlID = ? AND s.ProductionControlItemID = ? AND s.StationID = ?`,
          [productionControlID, Number(item.ProductionControlItemID), stationId]
    );
  }
}

app.get('/api/assemblies/:qrCode/boq', async (request, response) => {
  const qrCode = String(request.params.qrCode || '').trim();
  const contractorId = getContractorId(request);
  if (!contractorId) return response.status(401).json({ error: 'Contractor login required.' });
  const assembly = await contractorCanAccessQr(contractorId, qrCode);
  if (!assembly) return response.status(403).json({ error: 'Assembly is not assigned to this contractor.' });
  const [rows] = await mysqlConnection.query(
    `SELECT REPLACE(MainMark, CHAR(1), '') AS mainMark,
            REPLACE(PieceMark, CHAR(1), '') AS pieceMark,
            Quantity, Weight, Length, SurfaceArea, DimensionString
     FROM productioncontrolitems
     WHERE ProductionControlID = ? AND ProductionControlAssemblyID = ?
     ORDER BY ProductionControlItemID`,
    [assembly.productionControlID, assembly.productionControlAssemblyID]
  );
  response.json({
    jobNumber: assembly.jobNumber,
    assemblyMark: assembly.assemblyMark,
    assemblyQuantity: assembly.assemblyQuantity,
    assemblyWeightEach: assembly.assemblyWeightEach,
    items: (rows as Array<Record<string, any>>).map((row) => ({
      mainMark: cleanPowerFabValue(row.mainMark),
      pieceMark: cleanPowerFabValue(row.pieceMark),
      quantity: Number(row.Quantity ?? 0),
      weight: Number(row.Weight ?? 0),
      length: Number(row.Length ?? 0),
      surfaceArea: Number(row.SurfaceArea ?? 0),
      dimension: cleanPowerFabValue(row.DimensionString)
    }))
  });
});

app.post('/api/assemblies/:qrCode/status', async (request, response) => {
  const qrCode = String(request.params.qrCode || '').trim();
  const input = fabricationStageSchema.safeParse(request.body?.stage ?? request.body?.status);
  const stationInput = stationUpdateInput.safeParse(request.body?.stationData ?? request.body);

  if (!qrCode) return response.status(400).json({ error: 'QR code is required' });
  const contractorId = getContractorId(request);
  if (!contractorId) return response.status(401).json({ error: 'Contractor login required.' });
  const authorizedAssembly = await contractorCanAccessQr(contractorId, qrCode);
  if (!authorizedAssembly) return response.status(403).json({ error: 'Assembly is not assigned to this contractor.' });
  if (!input.success) return response.status(400).json({ error: 'Invalid fabrication stage', allowedStages: fabricationStages });
  if (!stationInput.success) return response.status(400).json({ error: 'Invalid station data', details: stationInput.error.flatten() });

  const stage = input.data;
  const station = await resolveStationByStage(stage);
  const routeRows = await getAssignedAssemblyRoute();
  const route = routeRows.find((row) => String(row.stationName ?? '').toLowerCase() === String(station?.Description ?? '').toLowerCase()) ?? null;

  const [latestRows] = await mysqlConnection.query(
    'SELECT stageName FROM `assembly_scan_history` WHERE `qrCode` = ? ORDER BY `createdAt` DESC LIMIT 1',
    [qrCode]
  );
  const latestStage = (latestRows as Array<Record<string, any>>)[0]?.stageName ?? null;
  const nextStage = await getAllowedNextStage(qrCode);

  if (latestStage && stage !== latestStage && nextStage && stage !== nextStage) {
    return response.status(400).json({
      error: `Stage update not allowed. Expected next stage: ${nextStage}.`,
      currentStage: latestStage,
      allowedNextStage: nextStage
    });
  }

  const assemblyMatch = authorizedAssembly;
  const resolvedJobNumber = String(request.body?.jobNumber ?? assemblyMatch?.jobNumber ?? '').trim();
  const resolvedAssemblyMark = String(request.body?.assemblyMark ?? assemblyMatch?.assemblyMark ?? '').replace(/\u0001/g, '').trim();
  const resolvedStationName = station ? String(station.Description ?? '') : String(request.body?.stationName ?? '');
  const resolvedRouteName = route ? String(route.routeName ?? '') : String(request.body?.routeName ?? 'Fabrication Route');

  const inserted = await mysqlConnection.query(
    `INSERT INTO \`assembly_scan_history\` (qrCode, jobNumber, assemblyMark, stationId, stationName, routeName, routeOrder, stageName, scannedBy, note, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      qrCode,
      resolvedJobNumber,
      resolvedAssemblyMark,
      station ? Number(station.StationID ?? 0) : null,
      resolvedStationName,
      resolvedRouteName,
      route ? Number(route.routeOrder ?? 0) : Number(request.body?.routeOrder ?? 0),
      stage,
      String(request.body?.scannedBy ?? 'mobile-app'),
      String(request.body?.note ?? `${stage} scan completed`)
    ]
  );

  const stationData = stationInput.data;
  const [stationInsert] = await mysqlConnection.query(
    `INSERT INTO \`assembly_station_updates\` (
      qrCode, mainMark, pieceMark, sequenceValue, lotNumber, quantity, instanceNumber, app,
      inspectionFailures, completedBy, hours, minutes, batchId, workArea, weight, finish,
      nextStation, remark, includeIfPreviousStationNotCompleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      qrCode,
      stationData.mainMark ?? resolvedAssemblyMark,
      stationData.pieceMark ?? resolvedAssemblyMark,
      stationData.sequenceValue ?? null,
      stationData.lotNumber ?? null,
      stationData.quantity ?? assemblyMatch?.assemblyQuantity ?? null,
      stationData.instanceNumber ?? null,
      stationData.app ?? null,
      stationData.inspectionFailures ?? 0,
      stationData.completedBy ?? request.body?.scannedBy ?? null,
      stationData.hours ?? 0,
      stationData.minutes ?? 0,
      stationData.batchId ?? null,
      stationData.workArea ?? resolvedStationName,
      stationData.weight ?? (assemblyMatch?.assemblyWeightEach ? `${assemblyMatch.assemblyWeightEach}` : null),
      stationData.finish ?? null,
      stationData.nextStation ?? null,
      stationData.remark ?? request.body?.note ?? null,
      stationData.includeIfPreviousStationNotCompleted ?? false
    ]
  );

  try {
    await syncAssemblyStationToPowerFabTables({
      qrCode,
      jobNumber: resolvedJobNumber,
      assemblyMark: resolvedAssemblyMark,
      productionControlID: assemblyMatch?.productionControlID,
      productionControlAssemblyID: assemblyMatch?.productionControlAssemblyID,
      stage,
      stationId: station ? Number(station.StationID ?? 0) : null,
      stationName: resolvedStationName,
      routeName: resolvedRouteName,
      routeOrder: route ? Number(route.routeOrder ?? 0) : Number(request.body?.routeOrder ?? 0),
      scannedBy: String(request.body?.scannedBy ?? 'mobile-app'),
      note: String(request.body?.note ?? `${stage} scan completed`),
      assemblyQuantity: assemblyMatch?.assemblyQuantity,
      assemblyWeightEach: assemblyMatch?.assemblyWeightEach,
      grossAssemblyWeightEach: assemblyMatch?.grossAssemblyWeightEach,
      assemblyLengthEach: assemblyMatch?.assemblyLengthEach,
      assemblySquareMetersEach: assemblyMatch?.assemblySquareMetersEach,
      assemblySurfaceAreaEach: assemblyMatch?.assemblySurfaceAreaEach,
      hours: Number(stationData.hours ?? 0),
      batchId: stationData.batchId ?? undefined
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown PowerFab sync error';
    return response.status(502).json({
      error: `Scan was saved in the portal but could not be written to PowerFab: ${message}`,
      saved: false,
      portalSaved: true
    });
  }

  const history = await mysqlConnection.query(
    'SELECT * FROM `assembly_scan_history` WHERE `qrCode` = ? ORDER BY `createdAt` ASC',
    [qrCode]
  );

  const historyRows = (history[0] as Array<Record<string, any>>).map((row) => ({
    stage: row.stageName,
    stationName: row.stationName,
    routeName: row.routeName,
    scannedBy: row.scannedBy,
    note: row.note,
    createdAt: row.createdAt
  }));

  assemblyStatusStore.set(qrCode, { currentStage: stage, history: historyRows.map((row) => ({ stage: row.stage, updatedAt: row.createdAt })) });

  response.json({ qrCode, currentStage: stage, history: historyRows, insertId: (stationInsert as any).insertId ?? null, saved: true });
});

app.post('/api/assemblies/:qrCode/fitup-inspections', async (request, response) => {
  const qrCode = String(request.params.qrCode || '').trim();
  const input = fitupInspectionInput.safeParse(request.body);
  const contractorId = getContractorId(request);
  if (!contractorId) return response.status(401).json({ error: 'Contractor login required.' });
  if (!input.success) return response.status(400).json({ error: 'Invalid fit-up inspection data.', details: input.error.flatten() });
  const assembly = await contractorCanAccessQr(contractorId, qrCode);
  if (!assembly) return response.status(403).json({ error: 'Assembly is not assigned to this contractor.' });
  const inspectionType = await getFitupInspectionRole(contractorId);
  if (!inspectionType) return response.status(403).json({ error: 'Fit-up inspection permission is not granted in PowerFab.' });
  const inspectionTestId = await getInspectionTestId(inspectionType);
  if (inspectionType === 'PAINTING_INSPECTION' && !(await hasConfirmedShippingReceipt(qrCode))) {
    return response.status(409).json({ error: 'Assembly has not been received. Confirm receipt from the Shipping Ticket before completing Painting Inspection.' });
  }
  if (inspectionType === 'CLIENT_FITUP' && !(await hasCompletedVendorFitup(assembly))) {
    return response.status(403).json({ error: 'Client/Fit-up Inspection is available only after Vendor/Fit-up Inspection is completed.' });
  }

  const savedChecks = {
    ...(input.data.checks ?? {}),
    ...(assembly.instanceNumber ? { instanceNumber: String(assembly.instanceNumber) } : {})
  };
  const inspectionData = { ...input.data, checks: savedChecks };
  const instanceNumbers = parseInspectionInstanceNumbers(savedChecks);
  const powerFabInspections = await getPowerFabInspectionHistory(assembly);
  const [previousRows] = await mysqlConnection.query(
    'SELECT result, checks FROM contractor_fitup_inspections WHERE qrCode = ? AND inspectionType = ? ORDER BY createdAt DESC',
    [qrCode, inspectionType]
  );
  const passedInstanceNumbers = new Set<number>();
  (previousRows as Array<Record<string, any>>).forEach((row) => {
    if (row.result !== 'PASS') return;
    let checks: Record<string, unknown> = {};
    try {
      checks = typeof row.checks === 'string' ? JSON.parse(row.checks) : (row.checks ?? {});
    } catch {
      checks = {};
    }
    parseInspectionInstanceNumbers(checks).forEach((value) => passedInstanceNumbers.add(value));
  });
  if (inspectionType === 'VENDOR_FITUP') {
    powerFabInspections.forEach((inspection) => {
      if (inspection.result !== 'PASS') return;
      parseInspectionInstanceNumbers(inspection.checks).forEach((value) => passedInstanceNumbers.add(value));
    });
  }
  const alreadyPassed = instanceNumbers.filter((value) => passedInstanceNumbers.has(value));
  if (alreadyPassed.length) {
    return response.status(409).json({
      error: `Instance number${alreadyPassed.length === 1 ? '' : 's'} ${alreadyPassed.join(', ')} already passed inspection and cannot be scanned again.`
    });
  }

  const [result] = await mysqlConnection.query(
    `INSERT INTO contractor_fitup_inspections (contractorId, qrCode, jobNumber, assemblyMark, inspectionType, result, inspector, remarks, checks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [contractorId, qrCode, assembly.jobNumber, assembly.assemblyMark, inspectionType, input.data.result, input.data.inspector, input.data.remarks ?? null, JSON.stringify(savedChecks)]
  );
  try {
    await syncInspectionToPowerFab(assembly, inspectionData, inspectionType, contractorId);
    if (inspectionData.result === 'PASS') await markAssemblyPieceTrackingComplete(assembly, savedChecks, inspectionType);
    await reconcileFitupInspectionStatus(Number(assembly.productionControlID ?? 0));
  } catch (error) {
    console.error('Unable to sync inspection to PowerFab tables', error);
    return response.status(500).json({ error: 'Inspection was saved in the portal but could not be written to PowerFab.' });
  }
  response.status(201).json({ saved: true, inspectionId: (result as any).insertId, result: input.data.result });
});

app.get('/api/assemblies/:qrCode/fitup-inspections', async (request, response) => {
  const qrCode = String(request.params.qrCode || '').trim();
  const contractorId = getContractorId(request);
  if (!contractorId) return response.status(401).json({ error: 'Contractor login required.' });
  const assembly = await contractorCanAccessQr(contractorId, qrCode);
  if (!assembly) return response.status(403).json({ error: 'Assembly is not assigned to this contractor.' });
  const inspectionType = await getFitupInspectionRole(contractorId);
  if (!inspectionType) return response.status(403).json({ error: 'Fit-up inspection permission is not granted in PowerFab.' });
  const inspectionTestId = await getInspectionTestId(inspectionType);
  const [rows] = await mysqlConnection.query('SELECT id, inspectionType, result, inspector, remarks, checks, createdAt FROM contractor_fitup_inspections WHERE qrCode = ? ORDER BY createdAt DESC', [qrCode]);
  const powerFabInspections = await getPowerFabInspectionHistory(assembly);
  const availableInstanceNumbers = await getAvailableAssemblyInstanceNumbers(assembly);
  const targetInstanceNumber = Number(assembly.instanceNumber ?? 0);
  const completedInstanceNumbers = new Set<number>();
  const passedInstanceNumbers = new Set<number>();
  const inspections = (rows as Array<Record<string, any>>).map((row) => {
    let checks: Record<string, unknown> = {};
    try {
      checks = typeof row.checks === 'string' ? JSON.parse(row.checks) : (row.checks ?? {});
    } catch {
      checks = {};
    }
    const instanceNumbers = parseInspectionInstanceNumbers(checks);
    if (row.inspectionType === inspectionType) {
      instanceNumbers.forEach((value) => completedInstanceNumbers.add(value));
      if (row.result === 'PASS') instanceNumbers.forEach((value) => passedInstanceNumbers.add(value));
    }
    return { ...row, checks };
  });
  const allInspections = [...inspections, ...powerFabInspections].sort((first, second) => {
    const firstRecord = first as Record<string, any>;
    const secondRecord = second as Record<string, any>;
    return new Date(String(secondRecord.createdAt ?? 0)).getTime() - new Date(String(firstRecord.createdAt ?? 0)).getTime();
  });
  if (inspectionType === 'VENDOR_FITUP' || inspectionType === 'PAINTING_INSPECTION') powerFabInspections
    .filter((inspection) => inspection.inspectionTestId === inspectionTestId)
    .forEach((inspection) => {
    const instanceNumbers = parseInspectionInstanceNumbers(inspection.checks);
    instanceNumbers.forEach((value) => {
      completedInstanceNumbers.add(value);
      if (inspection.result === 'PASS') passedInstanceNumbers.add(value);
    });
  });
  const completed = [...completedInstanceNumbers].filter((value) => availableInstanceNumbers.includes(value));
  const passed = [...passedInstanceNumbers].filter((value) => availableInstanceNumbers.includes(value));
  const inspectionComplete = targetInstanceNumber > 0
    ? passedInstanceNumbers.has(targetInstanceNumber)
    : availableInstanceNumbers.length > 0 && availableInstanceNumbers.every((value) => passedInstanceNumbers.has(value));
  response.json({
    inspections: allInspections,
    availableInstanceNumbers,
    completedInstanceNumbers: completed,
    passedInstanceNumbers: passed,
    inspectionComplete,
    instanceNumber: targetInstanceNumber || null
  });
});

async function getShippingEligibleAssemblies(jobNumber: string) {
  const [jobRows] = await mysqlConnection.query(
    'SELECT ProductionControlID FROM productioncontroljobs WHERE JobNumber = ? LIMIT 1',
    [jobNumber]
  );
  const productionControlID = Number((jobRows as Array<Record<string, any>>)[0]?.ProductionControlID ?? 0);
  if (!productionControlID) return [];
  const [assemblyRows] = await mysqlConnection.query(
    `SELECT ProductionControlAssemblyID, REPLACE(MainMark, CHAR(1), '') AS assemblyMark, AssemblyQuantity, AssemblyWeightEach
     FROM productioncontrolassemblies WHERE ProductionControlID = ? ORDER BY MainMark, ProductionControlAssemblyID`,
    [productionControlID]
  );
  const eligible = [] as Array<{ qrCode: string; assemblyMark: string; quantity: number; weight: number; passedInstances: number[] }>;
  for (const row of assemblyRows as Array<Record<string, any>>) {
    const assemblyId = Number(row.ProductionControlAssemblyID ?? 0);
    if (!assemblyId) continue;
    const assembly = {
      qrCode: buildAssemblyQrCode(jobNumber, assemblyId), jobNumber, productionControlID,
      productionControlAssemblyID: assemblyId, assemblyMark: String(row.assemblyMark ?? '').trim(),
      assemblyQuantity: Number(row.AssemblyQuantity ?? 0), assemblyWeightEach: Number(row.AssemblyWeightEach ?? 0)
    };
    const availableInstances = await getAvailableAssemblyInstanceNumbers(assembly);
    if (!availableInstances.length) continue;
    const passedInstances = new Set<number>();
    const [inspectionRows] = await mysqlConnection.query(
      'SELECT result, checks FROM contractor_fitup_inspections WHERE jobNumber = ? AND assemblyMark = ? AND result = \'PASS\'',
      [jobNumber, assembly.assemblyMark]
    );
    for (const inspection of inspectionRows as Array<Record<string, any>>) {
      try { parseInspectionInstanceNumbers(typeof inspection.checks === 'string' ? JSON.parse(inspection.checks) : (inspection.checks ?? {})).forEach((value) => passedInstances.add(value)); } catch { /* ignore malformed historical checks */ }
    }
    for (const inspection of await getPowerFabInspectionHistory(assembly)) {
      if (inspection.result === 'PASS') parseInspectionInstanceNumbers(inspection.checks).forEach((value) => passedInstances.add(value));
    }
    if (!availableInstances.every((value) => passedInstances.has(value))) continue;
    eligible.push({ qrCode: assembly.qrCode, assemblyMark: assembly.assemblyMark || 'Unknown Assembly', quantity: availableInstances.length, weight: Number((assembly.assemblyWeightEach * availableInstances.length).toFixed(3)), passedInstances: availableInstances });
  }
  return eligible;
}

app.get('/api/shipping-tickets', async (request, response) => {
  const jobNumber = String(request.query.job || '').trim();
  const contractorId = getContractorId(request);
  if (!contractorId) return response.status(401).json({ error: 'Contractor login required.' });
  if (!jobNumber) return response.status(400).json({ error: 'job query parameter is required.' });
  if (!(await contractorCanAccessJob(contractorId, jobNumber))) return response.status(403).json({ error: 'Project is not assigned to this contractor.' });
  try {
    const eligible = await getShippingEligibleAssemblies(jobNumber);
    const [ticketRows] = await mysqlConnection.query(
      `SELECT st.id, st.ticketNumber, st.shippingDate, st.destination, st.remarks, st.createdAt,
              COUNT(sti.id) AS assemblyCount, COALESCE(SUM(sti.quantity), 0) AS quantity, COALESCE(SUM(sti.weight), 0) AS weight
       FROM shipping_tickets st LEFT JOIN shipping_ticket_items sti ON sti.shippingTicketId = st.id
       WHERE st.jobNumber = ? GROUP BY st.id ORDER BY st.createdAt DESC`, [jobNumber]
    );
    response.json({ eligibleAssemblies: eligible, tickets: ticketRows });
  } catch (error) {
    console.error('Unable to load shipping tickets', error);
    response.status(500).json({ error: 'Unable to load shipping tickets.' });
  }
});

app.post('/api/shipping-tickets', async (request, response) => {
  const input = shippingTicketInput.safeParse(request.body);
  const contractorId = getContractorId(request);
  if (!contractorId) return response.status(401).json({ error: 'Contractor login required.' });
  if (!input.success) return response.status(400).json({ error: 'Select at least one inspected assembly.' });
  const jobNumber = String(request.query.job || '').trim();
  if (!jobNumber) return response.status(400).json({ error: 'job query parameter is required.' });
  if (!(await contractorCanAccessJob(contractorId, jobNumber))) return response.status(403).json({ error: 'Project is not assigned to this contractor.' });
  try {
    const requestedCodes = [...new Set(input.data.qrCodes)];
    const eligible = await getShippingEligibleAssemblies(jobNumber);
    const selected = eligible.filter((assembly) => requestedCodes.includes(assembly.qrCode));
    if (selected.length !== requestedCodes.length) return response.status(400).json({ error: 'One or more selected assemblies have not completed a PASS inspection.' });
    const [shippedRows] = await mysqlConnection.query(
      `SELECT sti.qrCode FROM shipping_ticket_items sti JOIN shipping_tickets st ON st.id = sti.shippingTicketId
       WHERE st.jobNumber = ? AND sti.qrCode IN (${requestedCodes.map(() => '?').join(',')})`,
      [jobNumber, ...requestedCodes]
    );
    if ((shippedRows as Array<Record<string, any>>).length) return response.status(409).json({ error: 'One or more selected assemblies are already assigned to a shipping ticket.' });
    const ticketNumber = `ST-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const [ticketResult] = await mysqlConnection.query(
      'INSERT INTO shipping_tickets (ticketNumber, jobNumber, contractorId, shippingDate, destination, remarks) VALUES (?, ?, ?, ?, ?, ?)',
      [ticketNumber, jobNumber, contractorId, input.data.shippingDate || null, input.data.destination || null, input.data.remarks || null]
    );
    const shippingTicketId = Number((ticketResult as any).insertId);
    for (const assembly of selected) {
      await mysqlConnection.query(
        'INSERT INTO shipping_ticket_items (shippingTicketId, qrCode, assemblyMark, quantity, weight) VALUES (?, ?, ?, ?, ?)',
        [shippingTicketId, assembly.qrCode, assembly.assemblyMark, assembly.quantity, assembly.weight]
      );
    }
    response.status(201).json({ saved: true, ticketNumber, assemblyCount: selected.length });
  } catch (error) {
    console.error('Unable to create shipping ticket', error);
    response.status(500).json({ error: 'Unable to create shipping ticket.' });
  }
});

app.get('/api/shipping-tickets/:ticketNumber/qr', async (request, response) => {
  const ticketNumber = String(request.params.ticketNumber || '').trim();
  if (!ticketNumber) return response.status(400).send('Ticket number is required');
  try {
    const scanUrl = `${publicAppUrl}/shipping-receipt.html?ticket=${encodeURIComponent(ticketNumber)}`;
    const png = await QRCode.toBuffer(scanUrl, { type: 'png', width: 600, margin: 2, errorCorrectionLevel: 'H' });
    response.type('png').send(png);
  } catch (error) {
    console.error('Unable to render shipping ticket QR code', error);
    response.status(500).send('Unable to render shipping ticket QR code');
  }
});

app.get('/api/shipping-tickets/:ticketNumber/receipt', async (request, response) => {
  const contractorId = await requireCoatingUser(request, response);
  const ticketNumber = String(request.params.ticketNumber || '').trim();
  if (!contractorId) return;
  try {
    const [ticketRows] = await mysqlConnection.query(
      `SELECT id, ticketNumber, jobNumber, shippingDate, destination, remarks, createdAt
       FROM shipping_tickets WHERE ticketNumber = ? LIMIT 1`,
      [ticketNumber]
    );
    const ticket = (ticketRows as Array<Record<string, any>>)[0];
    if (!ticket) return response.status(404).json({ error: 'Shipping ticket not found.' });
    if (!(await contractorCanAccessJob(contractorId, String(ticket.jobNumber))) && !await isAccessAdmin(contractorId)) {
      return response.status(403).json({ error: 'This shipping ticket is not assigned to this user.' });
    }
    const [itemRows] = await mysqlConnection.query(
            `SELECT sti.qrCode, sti.assemblyMark, sti.quantity, sti.weight,
              str.receivedBy, str.receivedAt, streturn.returnedBy, streturn.returnedAt
       FROM shipping_ticket_items sti
       LEFT JOIN shipping_ticket_receipts str ON str.shippingTicketId = sti.shippingTicketId AND str.qrCode = sti.qrCode
             LEFT JOIN shipping_ticket_returns streturn ON streturn.shippingTicketId = sti.shippingTicketId AND streturn.qrCode = sti.qrCode
       WHERE sti.shippingTicketId = ? ORDER BY sti.assemblyMark, sti.qrCode`,
      [ticket.id]
    );
    response.json({ ticket, items: itemRows });
  } catch (error) {
    console.error('Unable to load shipping ticket receipt', error);
    response.status(500).json({ error: 'Unable to load shipping ticket receipt.' });
  }
});

app.post('/api/shipping-tickets/:ticketNumber/receipt', async (request, response) => {
  const contractorId = await requireCoatingUser(request, response);
  const ticketNumber = String(request.params.ticketNumber || '').trim();
  const qrCodes = [...new Set(Array.isArray(request.body?.qrCodes) ? request.body.qrCodes.map((value: unknown) => String(value).trim()).filter(Boolean) : [])];
  if (!contractorId) return;
  if (!qrCodes.length) return response.status(400).json({ error: 'Select at least one assembly instance.' });
  try {
    const [ticketRows] = await mysqlConnection.query('SELECT id, jobNumber FROM shipping_tickets WHERE ticketNumber = ? LIMIT 1', [ticketNumber]);
    const ticket = (ticketRows as Array<Record<string, any>>)[0];
    if (!ticket) return response.status(404).json({ error: 'Shipping ticket not found.' });
    if (!(await contractorCanAccessJob(contractorId, String(ticket.jobNumber))) && !await isAccessAdmin(contractorId)) {
      return response.status(403).json({ error: 'This shipping ticket is not assigned to this user.' });
    }
    const placeholders = qrCodes.map(() => '?').join(',');
    const [itemRows] = await mysqlConnection.query(
      `SELECT qrCode FROM shipping_ticket_items WHERE shippingTicketId = ? AND qrCode IN (${placeholders})`,
      [ticket.id, ...qrCodes]
    );
    if ((itemRows as Array<Record<string, any>>).length !== qrCodes.length) return response.status(400).json({ error: 'One or more selected assemblies are not on this ticket.' });
    for (const qrCode of qrCodes) {
      await mysqlConnection.query(
        'INSERT IGNORE INTO shipping_ticket_receipts (shippingTicketId, qrCode, receivedBy) VALUES (?, ?, ?)',
        [ticket.id, qrCode, contractorId]
      );
      await syncShippingInstanceState(String(qrCode), 'received');
    }
    response.json({ saved: true, receivedCount: qrCodes.length });
  } catch (error) {
    console.error('Unable to save shipping ticket receipt', error);
    response.status(500).json({ error: 'Unable to save shipping ticket receipt.' });
  }
});

app.post('/api/shipping-tickets/:ticketNumber/return', async (request, response) => {
  const contractorId = await requireCoatingUser(request, response);
  const ticketNumber = String(request.params.ticketNumber || '').trim();
  const qrCodes = [...new Set(Array.isArray(request.body?.qrCodes) ? request.body.qrCodes.map((value: unknown) => String(value).trim()).filter(Boolean) : [])];
  const reason = String(request.body?.reason ?? '').trim().slice(0, 1000) || null;
  if (!contractorId) return;
  if (!qrCodes.length) return response.status(400).json({ error: 'Select at least one assembly instance.' });
  try {
    const [ticketRows] = await mysqlConnection.query('SELECT id, jobNumber FROM shipping_tickets WHERE ticketNumber = ? LIMIT 1', [ticketNumber]);
    const ticket = (ticketRows as Array<Record<string, any>>)[0];
    if (!ticket) return response.status(404).json({ error: 'Shipping ticket not found.' });
    if (!(await contractorCanAccessJob(contractorId, String(ticket.jobNumber))) && !await isAccessAdmin(contractorId)) return response.status(403).json({ error: 'This shipping ticket is not assigned to this user.' });
    const placeholders = qrCodes.map(() => '?').join(',');
    const [itemRows] = await mysqlConnection.query(`SELECT qrCode FROM shipping_ticket_items WHERE shippingTicketId = ? AND qrCode IN (${placeholders})`, [ticket.id, ...qrCodes]);
    if ((itemRows as Array<Record<string, any>>).length !== qrCodes.length) return response.status(400).json({ error: 'One or more selected assemblies are not on this ticket.' });
    for (const qrCode of qrCodes) {
      await mysqlConnection.query('INSERT INTO shipping_ticket_returns (shippingTicketId, qrCode, returnedBy, reason) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE reason=VALUES(reason)', [ticket.id, qrCode, contractorId, reason]);
      await syncShippingInstanceState(String(qrCode), 'returned');
    }
    response.json({ saved: true, returnedCount: qrCodes.length });
  } catch (error) {
    console.error('Unable to save shipping ticket return', error);
    response.status(500).json({ error: 'Unable to save shipping ticket return.' });
  }
});
const optionalPaintNumber = (schema:z.ZodTypeAny) => z.preprocess(value => value === '' || value === null || value === undefined ? undefined : value, schema.optional());
const paintLoadInput = z.object({ loadNumber:z.string().trim().min(1).max(255), topTextDescription:z.string().trim().max(255).optional(), shippedFrom:z.string().trim().max(255).optional(), destinationGroupId:optionalPaintNumber(z.coerce.number().int().positive()), plannedShipDate:z.string().trim().max(10).optional(), capacity:optionalPaintNumber(z.coerce.number().finite().nonnegative()), trailerNumber:z.string().trim().max(255).optional(), carrier:z.string().trim().max(255).optional(), driverName:z.string().trim().max(255).optional(), pickupLocation:z.string().trim().max(255).optional(), receivingLocation:z.string().trim().max(255).optional() });
const paintLoadItemsInput = z.object({ qrCodes:z.array(z.string().trim().min(1)).min(1).max(500) });
async function queryClientPaintEligible(jobNumber:string, _loadId=0) {
  const [jr]=await mysqlConnection.query('SELECT ProductionControlID, Comment2 FROM productioncontroljobs WHERE JobNumber=? LIMIT 1',[jobNumber]);
  const pdc=Number((jr as any[])[0]?.ProductionControlID||0),prefix=String((jr as any[])[0]?.Comment2||jobNumber).trim(); if(!pdc)return [];
  const [ar]=await mysqlConnection.query("SELECT ProductionControlAssemblyID,REPLACE(MainMark,CHAR(1),'') assemblyMark,AssemblyQuantity,AssemblyWeightEach FROM productioncontrolassemblies WHERE ProductionControlID=?",[pdc]);
  const out:any[]=[];
  for(const r of ar as any[]){
    const assemblyId=Number(r.ProductionControlAssemblyID),assemblyMark=String(r.assemblyMark||'').trim(); if(!assemblyId||!assemblyMark)continue;
    const assembly={qrCode:buildAssemblyQrCode(jobNumber,assemblyId),jobNumber,productionControlID:pdc,productionControlAssemblyID:assemblyId,assemblyMark,assemblyQuantity:Number(r.AssemblyQuantity||0),assemblyWeightEach:Number(r.AssemblyWeightEach||0)};
    const [descriptionRows]=await mysqlConnection.query("SELECT COALESCE(d.Description, pci.Remark, '') AS description FROM productioncontrolitems pci LEFT JOIN drawings d ON d.DrawingID=pci.DrawingID WHERE pci.ProductionControlID=? AND pci.ProductionControlAssemblyID=? ORDER BY pci.ProductionControlItemID LIMIT 1",[pdc,assemblyId]);const description=String((descriptionRows as any[])[0]?.description||'');const available=await getAvailableAssemblyInstanceNumbers(assembly),passed=new Set<number>();
    const [completedRows]=await mysqlConnection.query(`SELECT DISTINCT si.InstanceNumber
      FROM productioncontrolitemstationsummaryinstancenumbers si
      JOIN productioncontrolitemstationsummary s ON s.ProductionControlItemStationSummaryID=si.ProductionControlItemStationSummaryID
      JOIN productioncontrolitems pci ON pci.ProductionControlItemID=s.ProductionControlItemID
      WHERE s.ProductionControlID=? AND pci.ProductionControlAssemblyID=? AND s.StationID=7 AND si.Completed=1`,[pdc,assemblyId]);
    for(const x of completedRows as any[]){const instanceNumber=Number(x.InstanceNumber);if(Number.isInteger(instanceNumber)&&instanceNumber>0)passed.add(instanceNumber)}
    const [ir]=await mysqlConnection.query("SELECT checks FROM contractor_fitup_inspections WHERE jobNumber=? AND assemblyMark=? AND inspectionType='CLIENT_FITUP' AND result='PASS'",[jobNumber,assemblyMark]);
    for(const x of ir as any[]){try{parseInspectionInstanceNumbers(typeof x.checks==='string'?JSON.parse(x.checks):x.checks||{}).forEach(n=>passed.add(n))}catch{}}
    for(const x of await getPowerFabInspectionHistory(assembly))if(x.inspectionTestId===2&&x.result==='PASS')parseInspectionInstanceNumbers(x.checks).forEach(n=>passed.add(n));
    for(const instanceNumber of available.filter(n=>passed.has(n))){
      const [assigned]=await mysqlConnection.query(`SELECT 1 FROM productioncontrolitemtrucks pit JOIN productioncontrolitemtruckinstancenumbers pi ON pi.ProductionControlItemTruckID=pit.ProductionControlItemTruckID WHERE pit.ProductionControlID=? AND REPLACE(pit.MainMark,CHAR(1),'')=? AND pi.InstanceNumber=? LIMIT 1`,[pdc,assemblyMark,instanceNumber]);
      if((assigned as any[]).length)continue;
      out.push({qrCode:buildAssemblyQrCode(jobNumber,`${assemblyId}-${instanceNumber}`),assemblyId,assemblyMark,instanceNumber,instanceMark:`${prefix}-${assemblyMark}-${instanceNumber}`,description,quantity:1,weight:assembly.assemblyWeightEach});
    }
  }
  return out;
}
async function markPaintInstancesComplete(productionControlID:number,assemblyId:number,instanceNumbers:number[]){const [items]=await mysqlConnection.query('SELECT ProductionControlItemID FROM productioncontrolitems WHERE ProductionControlID=? AND ProductionControlAssemblyID=? AND InstanceTracking=3 ORDER BY ProductionControlItemID LIMIT 1',[productionControlID,assemblyId]);const itemId=Number((items as any[])[0]?.ProductionControlItemID||0);if(!itemId)return;await mysqlConnection.query(`INSERT IGNORE INTO productioncontrolitemstationsummaryinstancenumbers (ProductionControlItemStationSummaryID,ProductionControlItemID,InstanceNumber,Completed,Hours,DateCompleted,HasFailedInspectionTest) SELECT s.ProductionControlItemStationSummaryID,?,pin.InstanceNumber,0,0,NULL,0 FROM productioncontrolitemstationsummary s JOIN productioncontroliteminstancenumbers pin ON pin.ProductionControlItemID=? WHERE s.ProductionControlID=? AND s.ProductionControlItemID=? AND s.StationID=8`,[itemId,itemId,productionControlID,itemId]);for(const instanceNumber of instanceNumbers)await mysqlConnection.query(`UPDATE productioncontrolitemstationsummaryinstancenumbers si JOIN productioncontrolitemstationsummary s ON s.ProductionControlItemStationSummaryID=si.ProductionControlItemStationSummaryID SET si.Completed=1,si.DateCompleted=CURDATE(),si.HasFailedInspectionTest=0 WHERE s.ProductionControlID=? AND s.ProductionControlItemID=? AND s.StationID=8 AND si.InstanceNumber=?`,[productionControlID,itemId,instanceNumber]);await mysqlConnection.query(`UPDATE productioncontrolitemstationsummary s SET s.QuantityCompleted=(SELECT COUNT(*) FROM productioncontrolitemstationsummaryinstancenumbers si WHERE si.ProductionControlItemStationSummaryID=s.ProductionControlItemStationSummaryID AND si.Completed=1),s.LastDateCompleted=CURDATE(),s.FailedInspectionTestQuantity=0 WHERE s.ProductionControlID=? AND s.ProductionControlItemID=? AND s.StationID=8`,[productionControlID,itemId]);}
async function reconcilePaintLoadStatus(loadId:number){
  await mysqlConnection.query(`UPDATE productioncontrolitemstationsummaryinstancenumbers si
    JOIN productioncontrolitemstationsummary s ON s.ProductionControlItemStationSummaryID=si.ProductionControlItemStationSummaryID
    JOIN productioncontrolitemtruckinstancenumbers pi ON pi.ProductionControlItemID=s.ProductionControlItemID AND pi.InstanceNumber=si.InstanceNumber
    JOIN productioncontrolitemtrucks pit ON pi.ProductionControlItemTruckID=pit.ProductionControlItemTruckID
    SET si.Completed=1,si.DateCompleted=CURDATE(),si.HasFailedInspectionTest=0
    WHERE pit.TruckID=? AND s.StationID=8`,[loadId]);
  await mysqlConnection.query(`UPDATE productioncontrolitemstationsummary s
    JOIN productioncontrolitemtruckinstancenumbers pi ON pi.ProductionControlItemID=s.ProductionControlItemID
    JOIN productioncontrolitemtrucks pit ON pi.ProductionControlItemTruckID=pit.ProductionControlItemTruckID
    SET s.QuantityCompleted=(SELECT COUNT(*) FROM productioncontrolitemstationsummaryinstancenumbers si WHERE si.ProductionControlItemStationSummaryID=s.ProductionControlItemStationSummaryID AND si.Completed=1),s.LastDateCompleted=CURDATE(),s.FailedInspectionTestQuantity=0
    WHERE pit.TruckID=? AND s.StationID=8`,[loadId]);
}
async function reconcileFitupInspectionStatus(productionControlId:number){
  await mysqlConnection.query(`UPDATE productioncontrolitemstationsummaryinstancenumbers si
    JOIN productioncontrolitemstationsummary s ON s.ProductionControlItemStationSummaryID=si.ProductionControlItemStationSummaryID
    JOIN productioncontrolitems pci ON pci.ProductionControlItemID=s.ProductionControlItemID
    JOIN inspectiontestrecords itr ON itr.InspectionTestID IN (1,2,3) AND itr.TestFailed=0
    JOIN productioncontrolitemstations pis ON pis.ProductionControlItemStationID=itr.ProductionControlItemStationID
    JOIN inspectionteststrings its ON its.InspectionTestStringID=itr.InstanceNumberStringID
    SET si.Completed=1,si.DateCompleted=COALESCE(si.DateCompleted,CURDATE()),si.HasFailedInspectionTest=0
    WHERE pci.ProductionControlID=?
      AND REPLACE(pci.MainMark,CHAR(1),'')=REPLACE(pis.MainMark,CHAR(1),'')
      AND s.StationID=CASE itr.InspectionTestID WHEN 1 THEN 6 WHEN 2 THEN 7 WHEN 3 THEN 9 END
      AND FIND_IN_SET(CAST(si.InstanceNumber AS CHAR),REPLACE(its.String,' ',''))>0`,[productionControlId]);
  await mysqlConnection.query(`UPDATE productioncontrolitemstationsummary s
    SET s.QuantityCompleted=(SELECT COUNT(*) FROM productioncontrolitemstationsummaryinstancenumbers si WHERE si.ProductionControlItemStationSummaryID=s.ProductionControlItemStationSummaryID AND si.Completed=1),
        s.LastDateCompleted=CASE WHEN s.QuantityCompleted>0 THEN CURDATE() ELSE s.LastDateCompleted END,
        s.FailedInspectionTestQuantity=0
    WHERE s.ProductionControlID=? AND s.StationID IN (6,7,9)`,[productionControlId]);
}
function paintAccess(request:express.Request){const job=String(request.query.job||'').trim(),cid=getContractorId(request);return {job,cid}}
async function contractorCanUseShiftToPaint(contractorId:number){
  const [rows]=await mysqlConnection.query('SELECT enabled FROM contractor_feature_permissions WHERE contractorId=? AND featureName=? LIMIT 1',[contractorId,'SHIPPING']);
  return Boolean((rows as Array<Record<string, any>>)[0]?.enabled) || isShippingGroup(await getContractorGroup(contractorId));
}
app.use('/api/paint-loads',async(request,response,next)=>{
  const contractorId=getContractorId(request);
  if(!contractorId)return response.status(401).json({error:'Contractor login required.'});
  if(!(await contractorCanUseShiftToPaint(contractorId)))return response.status(403).json({error:'Shipping access is not enabled for this user.'});
  next();
});
async function clientPaintEligible(jobNumber:string,loadId=0){try{return await queryClientPaintEligible(jobNumber,loadId)}catch(error){console.error('Unable to load eligible paint assemblies',error);return []}}
app.get('/api/paint-loads',async(request,response)=>{
  const {job,cid}=paintAccess(request); if(!cid)return response.status(401).json({error:'Contractor login required.'});
  if(!job||!(await contractorCanAccessJob(cid,job)))return response.status(403).json({error:'Project is not assigned to this contractor.'});
  try{
    const [jr]=await mysqlConnection.query('SELECT ProductionControlID,Comment2 FROM productioncontroljobs WHERE JobNumber=? LIMIT 1',[job]);
    const pdc=Number((jr as any[])[0]?.ProductionControlID||0),load=Number(request.query.load||0);
    const [loads]=await mysqlConnection.query('SELECT TruckID,TruckNumber,TrailerNumber,Carrier,Capacity,LoadCategory1,LoadCategory2,LoadCategory3,Shipped,ShippedDate,ShippedFrom,ShippingDestinationGroupID,PlannedShipDate,TopText,QuantityAssigned,AssignedWeight FROM productioncontroltrucks WHERE ProductionControlID=? ORDER BY TruckID DESC',[pdc]);
    const [topTexts]=await mysqlConnection.query('SELECT Description,TopText FROM productioncontrolshippingtoptexts ORDER BY Description');
    const [destinations]=await mysqlConnection.query('SELECT ShippingDestinationGroupID,DestinationGroup FROM shippingdestinationgroups WHERE Active=1 ORDER BY DestinationGroup');
    const [shippingRoutes]=await mysqlConnection.query(`SELECT sr.ShippingRouteID,sr.Description AS routeName,srd.ShippingRouteDestinationID,srd.PositionInRoute,sdg.ShippingDestinationGroupID,sdg.DestinationGroup,COALESCE(f.FirmID,0) AS FirmID,COALESCE(f.Name,'') AS firmName,COALESCE(fa.FirmAddressID,0) AS FirmAddressID,COALESCE(fa.Description,'') AS addressName,COALESCE(fa.Address1,'') AS address1 FROM shippingroutes sr JOIN shippingroutedestinations srd ON srd.ShippingRouteID=sr.ShippingRouteID JOIN shippingdestinationgroups sdg ON sdg.ShippingDestinationGroupID=srd.ShippingDestinationGroupID LEFT JOIN shippingroutedestinationfirms srdf ON srdf.ShippingRouteDestinationID=srd.ShippingRouteDestinationID AND srdf.IsPrimary=1 LEFT JOIN firms f ON f.FirmID=srdf.FirmID LEFT JOIN firmaddresses fa ON fa.FirmAddressID=f.DefaultShipToAddressID WHERE sr.ProductionControlID=? ORDER BY sr.ShippingRouteID,srd.PositionInRoute,srd.ShippingRouteDestinationID`,[pdc]);
    const [loadTrackingSettings]=await mysqlConnection.query("SELECT VariableName,StringValue FROM variablescompanystandardsproductioncontrol WHERE VariableName REGEXP '^(TrailerNumber|Carrier|LoadCategory1|LoadCategory2|LoadCategory3)_(ShowField|Title|Required|RestrictToList)$'");
    const [loadTrackingPresets]=await mysqlConnection.query("SELECT FieldName,Value,SecondaryValue,ThirdValue FROM productioncontrolfieldvalues WHERE FieldName IN ('TrailerNumber','LoadCategory2','LoadCategory3') ORDER BY FieldName,Value");
    const [assignedAssemblies]=load?await mysqlConnection.query("SELECT REPLACE(pit.MainMark,CHAR(1),'') AS MainMark,REPLACE(pit.PieceMark,CHAR(1),'') AS PieceMark,pi.InstanceNumber,COALESCE(a.AssemblyWeightEach,0) AS Weight FROM productioncontrolitemtrucks pit JOIN productioncontrolitemtruckinstancenumbers pi ON pi.ProductionControlItemTruckID=pit.ProductionControlItemTruckID LEFT JOIN productioncontrolitems pci ON pci.ProductionControlItemID=pi.ProductionControlItemID LEFT JOIN productioncontrolassemblies a ON a.ProductionControlAssemblyID=pci.ProductionControlAssemblyID WHERE pit.ProductionControlID=? AND pit.TruckID=? ORDER BY pit.MainMark,pi.InstanceNumber",[pdc,load]):[[]];
    if(load) await reconcilePaintLoadStatus(load);
    response.json({loads,topTexts,destinations,shippingRoutes,loadTrackingSettings,loadTrackingPresets,jobPrefix:String((jr as any[])[0]?.Comment2||job).trim(),assignedAssemblies,eligibleAssemblies:load?await clientPaintEligible(job,load):[]});
  }catch(error){console.error('Unable to load PowerFab loads',error);response.status(500).json({error:'Unable to load PowerFab loads.'})}
});
app.get('/api/paint-loads',async(request,response)=>{const {job,cid}=paintAccess(request);if(!cid)return response.status(401).json({error:'Contractor login required.'});if(!job||!(await contractorCanAccessJob(cid,job)))return response.status(403).json({error:'Project is not assigned to this contractor.'});try{const [jr]=await mysqlConnection.query('SELECT ProductionControlID,Comment2 FROM productioncontroljobs WHERE JobNumber=? LIMIT 1',[job]);const pdc=Number((jr as any[])[0]?.ProductionControlID||0);const [loads]=await mysqlConnection.query('SELECT TruckID,TruckNumber,TrailerNumber,Carrier,Capacity,LoadCategory1,LoadCategory2,LoadCategory3,ShippedFrom,ShippingDestinationGroupID,PlannedShipDate,TopText,QuantityAssigned,AssignedWeight FROM productioncontroltrucks WHERE ProductionControlID=? ORDER BY TruckID DESC',[pdc]);const [topTexts]=await mysqlConnection.query('SELECT Description,TopText FROM productioncontrolshippingtoptexts ORDER BY Description');const [destinations]=await mysqlConnection.query('SELECT ShippingDestinationGroupID,DestinationGroup FROM shippingdestinationgroups WHERE Active=1 ORDER BY DestinationGroup');const [shippingRoutes]=await mysqlConnection.query(`SELECT sr.ShippingRouteID,sr.Description AS routeName,srd.ShippingRouteDestinationID,srd.PositionInRoute,sdg.ShippingDestinationGroupID,sdg.DestinationGroup,COALESCE(f.FirmID,0) AS FirmID,COALESCE(f.Name,'') AS firmName,COALESCE(fa.FirmAddressID,0) AS FirmAddressID,COALESCE(fa.Description,'') AS addressName,COALESCE(fa.Address1,'') AS address1 FROM shippingroutes sr JOIN shippingroutedestinations srd ON srd.ShippingRouteID=sr.ShippingRouteID JOIN shippingdestinationgroups sdg ON sdg.ShippingDestinationGroupID=srd.ShippingDestinationGroupID LEFT JOIN shippingroutedestinationfirms srdf ON srdf.ShippingRouteDestinationID=srd.ShippingRouteDestinationID AND srdf.IsPrimary=1 LEFT JOIN firms f ON f.FirmID=srdf.FirmID LEFT JOIN firmaddresses fa ON fa.FirmAddressID=f.DefaultShipToAddressID WHERE sr.ProductionControlID=? ORDER BY sr.ShippingRouteID,srd.PositionInRoute,srd.ShippingRouteDestinationID`,[pdc]);const [loadTrackingSettings]=await mysqlConnection.query("SELECT VariableName,StringValue FROM variablescompanystandardsproductioncontrol WHERE VariableName REGEXP '^(TrailerNumber|Carrier|LoadCategory1|LoadCategory2|LoadCategory3)_(ShowField|Title|Required|RestrictToList)$'");const [loadTrackingPresets]=await mysqlConnection.query("SELECT FieldName,Value,SecondaryValue,ThirdValue FROM productioncontrolfieldvalues WHERE FieldName IN ('TrailerNumber','LoadCategory2','LoadCategory3') ORDER BY FieldName,Value");const load=Number(request.query.load||0);const jobPrefix=String((jr as any[])[0]?.Comment2||job).trim();const [assignedAssemblies]=load?await mysqlConnection.query('SELECT REPLACE(pit.MainMark,CHAR(1),CONCAT()) AS MainMark,REPLACE(pit.PieceMark,CHAR(1),CONCAT()) AS PieceMark,pi.InstanceNumber,COALESCE(a.AssemblyWeightEach,0) AS Weight FROM productioncontrolitemtrucks pit JOIN productioncontrolitemtruckinstancenumbers pi ON pi.ProductionControlItemTruckID=pit.ProductionControlItemTruckID LEFT JOIN productioncontrolitems pci ON pci.ProductionControlItemID=pi.ProductionControlItemID LEFT JOIN productioncontrolassemblies a ON a.ProductionControlAssemblyID=pci.ProductionControlAssemblyID WHERE pit.ProductionControlID=? AND pit.TruckID=? ORDER BY pit.MainMark,pi.InstanceNumber',[pdc,load]):[[]];response.json({loads,topTexts,destinations,shippingRoutes,loadTrackingSettings,loadTrackingPresets,jobPrefix,assignedAssemblies,eligibleAssemblies:load?await clientPaintEligible(job,load):[]})}catch(e){console.error(e);response.status(500).json({error:'Unable to load PowerFab loads.'})}});
app.post('/api/paint-loads',async(request,response)=>{const input=paintLoadInput.safeParse(request.body);const {job,cid}=paintAccess(request);if(!cid)return response.status(401).json({error:'Contractor login required.'});if(!input.success)return response.status(400).json({error:'Load number is required.'});if(!job||!(await contractorCanAccessJob(cid,job)))return response.status(403).json({error:'Project is not assigned to this contractor.'});try{const [jr]=await mysqlConnection.query('SELECT ProductionControlID,Comment2 FROM productioncontroljobs WHERE JobNumber=? LIMIT 1',[job]);const pdc=Number((jr as any[])[0]?.ProductionControlID||0);const [tr]=await mysqlConnection.query('SELECT TopText FROM productioncontrolshippingtoptexts WHERE Description=? LIMIT 1',[input.data.topTextDescription||'Painting']);const top=(tr as any[])[0]?.TopText||'';const [r]=await mysqlConnection.query("INSERT INTO productioncontroltrucks (ProductionControlID,TruckNumber,TrailerNumber,Carrier,Capacity,LoadCategory1,LoadCategory2,LoadCategory3,ShippedFrom,ShippingDestinationGroupID,PlannedShipDate,TopText,Shipped,QuantityAssigned,AssignedLength,AssignedSquareMeters,AssignedWeight,AssignedSurfaceArea,QuantityLoaded,LoadedLength,LoadedSquareMeters,LoadedWeight,LoadedSurfaceArea,QuantityReturned,ReturnedLength,ReturnedSquareMeters,ReturnedWeight,ReturnedSurfaceArea,RecalculateTruckTotals) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1)",[pdc,input.data.loadNumber,input.data.trailerNumber||null,input.data.carrier||null,input.data.capacity??57320.19,input.data.driverName||null,input.data.pickupLocation||null,input.data.receivingLocation||null,input.data.shippedFrom||'Shop',input.data.destinationGroupId??1,input.data.plannedShipDate||null,top]);response.status(201).json({loadId:(r as any).insertId})}catch(e:any){response.status(e?.code==='ER_DUP_ENTRY'?409:500).json({error:e?.code==='ER_DUP_ENTRY'?'This load number already exists.':'Unable to create the PowerFab load.'})}});
app.post('/api/paint-loads/:loadId/items',async(request,response)=>{
  const input=paintLoadItemsInput.safeParse(request.body);const {job,cid}=paintAccess(request),load=Number(request.params.loadId);
  if(!cid)return response.status(401).json({error:'Contractor login required.'});if(!input.success||!load)return response.status(400).json({error:'Select at least one inspected instance.'});if(!job||!(await contractorCanAccessJob(cid,job)))return response.status(403).json({error:'Project is not assigned to this contractor.'});
  try{const [lr]=await mysqlConnection.query('SELECT ProductionControlID FROM productioncontroltrucks WHERE TruckID=? LIMIT 1',[load]);const pdc=Number((lr as any[])[0]?.ProductionControlID||0);const wanted=[...new Set(input.data.qrCodes)],items=(await clientPaintEligible(job)).filter(a=>wanted.includes(a.qrCode));if(!pdc||items.length!==wanted.length)return response.status(400).json({error:'Selected instance is not Client / Fit-up inspected or is already assigned to a load.'});
    const byAssembly=new Map<number,any[]>();for(const item of items)byAssembly.set(item.assemblyId,[...(byAssembly.get(item.assemblyId)||[]),item]);
    for(const [assemblyId,group] of byAssembly){const first=group[0];const [pi]=await mysqlConnection.query('SELECT ProductionControlItemID, MainMark, PieceMark FROM productioncontrolitems WHERE ProductionControlID=? AND ProductionControlAssemblyID=? AND InstanceTracking=3 ORDER BY ProductionControlItemID LIMIT 1',[pdc,assemblyId]);const sourceItem=(pi as any[])[0];const itemId=Number(sourceItem?.ProductionControlItemID||0);if(!itemId)throw Error('Assembly item not found.');const [inserted]=await mysqlConnection.query('INSERT INTO productioncontrolitemtrucks (ProductionControlID,MainMark,PieceMark,TruckID,SequenceID,PreviousShippingDestinationGroupID,Quantity,QuantityLoaded,QuantityReturned,RecalculateTruckTotals) VALUES (?,?,?, ?,0,0,?,0,0,1)',[pdc,sourceItem.MainMark,sourceItem.PieceMark||sourceItem.MainMark,load,group.length]);const truckItemId=Number((inserted as any).insertId);for(const instance of group)await mysqlConnection.query('INSERT INTO productioncontrolitemtruckinstancenumbers (ProductionControlItemTruckID,ProductionControlItemID,InstanceNumber,ShippingDestinationGroupID,DateLoaded) VALUES (?,?,?,1,NULL)',[truckItemId,itemId,instance.instanceNumber]);await markPaintInstancesComplete(pdc,assemblyId,group.map(instance=>instance.instanceNumber));}
    await mysqlConnection.query('UPDATE productioncontroltrucks SET QuantityAssigned=QuantityAssigned+?,AssignedWeight=AssignedWeight+?,RecalculateTruckTotals=1 WHERE TruckID=?',[items.length,items.reduce((n,a)=>n+a.weight,0),load]);await reconcilePaintLoadStatus(load);response.status(201).json({saved:true,instanceCount:items.length});
  }catch(e){console.error(e);response.status(500).json({error:'Unable to assign instances to this load.'})}
});
const paintLoadUpdateInput = paintLoadInput.partial();
app.patch('/api/paint-loads/:loadId',async(request,response)=>{
  const input=paintLoadUpdateInput.safeParse(request.body);const {job,cid}=paintAccess(request),load=Number(request.params.loadId);
  if(!cid)return response.status(401).json({error:'Contractor login required.'});if(!load||!input.success)return response.status(400).json({error:'Valid load details are required.'});if(!job||!(await contractorCanAccessJob(cid,job)))return response.status(403).json({error:'Project is not assigned to this contractor.'});
  try{const [rows]=await mysqlConnection.query('SELECT t.TruckID FROM productioncontroltrucks t JOIN productioncontroljobs j ON j.ProductionControlID=t.ProductionControlID WHERE t.TruckID=? AND j.JobNumber=? LIMIT 1',[load,job]);if(!(rows as any[]).length)return response.status(404).json({error:'Load not found.'});const d=input.data;await mysqlConnection.query('UPDATE productioncontroltrucks SET TruckNumber=COALESCE(?,TruckNumber),TrailerNumber=?,Carrier=?,Capacity=COALESCE(?,Capacity),LoadCategory1=?,LoadCategory2=?,LoadCategory3=?,ShippedFrom=?,ShippingDestinationGroupID=?,PlannedShipDate=?,RecalculateTruckTotals=1 WHERE TruckID=?',[d.loadNumber||null,d.trailerNumber||null,d.carrier||null,d.capacity??null,d.driverName||null,d.pickupLocation||null,d.receivingLocation||null,d.shippedFrom||null,d.destinationGroupId??null,d.plannedShipDate||null,load]);if(d.topTextDescription!==undefined){const [top]=await mysqlConnection.query('SELECT TopText FROM productioncontrolshippingtoptexts WHERE Description=? LIMIT 1',[d.topTextDescription]);await mysqlConnection.query('UPDATE productioncontroltrucks SET TopText=? WHERE TruckID=?',[(top as any[])[0]?.TopText||'',load])}response.json({saved:true})}catch(error){console.error('Unable to update PowerFab load',error);response.status(500).json({error:'Unable to update the PowerFab load.'})}
});
app.post('/api/paint-loads/:loadId/ship',async(request,response)=>{const {job,cid}=paintAccess(request),load=Number(request.params.loadId);if(!cid)return response.status(401).json({error:'Contractor login required.'});if(!load||!job||!(await contractorCanAccessJob(cid,job)))return response.status(403).json({error:'Project is not assigned to this contractor.'});try{const [rows]=await mysqlConnection.query('SELECT t.TruckID,t.QuantityAssigned FROM productioncontroltrucks t JOIN productioncontroljobs j ON j.ProductionControlID=t.ProductionControlID WHERE t.TruckID=? AND j.JobNumber=? LIMIT 1',[load,job]);if(!(rows as any[]).length)return response.status(404).json({error:'Load not found.'});if(!Number((rows as any[])[0].QuantityAssigned))return response.status(400).json({error:'Add at least one assembly instance before shipping this load.'});await mysqlConnection.query('UPDATE productioncontroltrucks SET Shipped=1,ShippedDate=COALESCE(ShippedDate,CURDATE()),RecalculateTruckTotals=1 WHERE TruckID=?',[load]);response.json({saved:true,shipped:true})}catch(error){console.error('Unable to ship PowerFab load',error);response.status(500).json({error:'Unable to ship the PowerFab load.'})}});
app.post('/api/paint-loads/:loadId/reopen',async(request,response)=>{const {job,cid}=paintAccess(request),load=Number(request.params.loadId);if(!cid)return response.status(401).json({error:'Contractor login required.'});if(!load||!job||!(await contractorCanAccessJob(cid,job)))return response.status(403).json({error:'Project is not assigned to this contractor.'});try{const [result]=await mysqlConnection.query('UPDATE productioncontroltrucks t JOIN productioncontroljobs j ON j.ProductionControlID=t.ProductionControlID SET t.Shipped=0,t.ShippedDate=NULL,t.RecalculateTruckTotals=1 WHERE t.TruckID=? AND j.JobNumber=?',[load,job]);if(!(result as any).affectedRows)return response.status(404).json({error:'Load not found.'});response.json({saved:true,shipped:false})}catch(error){console.error('Unable to reopen PowerFab load',error);response.status(500).json({error:'Unable to reopen the PowerFab load.'})}});
app.post('/api/paint-loads/:loadId/shipping-ticket',async(request,response)=>{const {job,cid}=paintAccess(request),load=Number(request.params.loadId);if(!cid)return response.status(401).json({error:'Contractor login required.'});if(!load||!job||!(await contractorCanAccessJob(cid,job)))return response.status(403).json({error:'Project is not assigned to this contractor.'});try{const [loadRows]=await mysqlConnection.query('SELECT t.TruckNumber,t.PlannedShipDate,t.ShippingDestinationGroupID,j.Comment2 FROM productioncontroltrucks t JOIN productioncontroljobs j ON j.ProductionControlID=t.ProductionControlID WHERE t.TruckID=? AND j.JobNumber=? LIMIT 1',[load,job]);const l=(loadRows as any[])[0];if(!l)return response.status(404).json({error:'Load not found.'});const [items]=await mysqlConnection.query("SELECT REPLACE(pit.MainMark,CHAR(1),'') AS assemblyMark,pi.InstanceNumber,COALESCE(a.AssemblyWeightEach,0) AS weight FROM productioncontrolitemtrucks pit JOIN productioncontrolitemtruckinstancenumbers pi ON pi.ProductionControlItemTruckID=pit.ProductionControlItemTruckID LEFT JOIN productioncontrolitems pci ON pci.ProductionControlItemID=pi.ProductionControlItemID LEFT JOIN productioncontrolassemblies a ON a.ProductionControlAssemblyID=pci.ProductionControlAssemblyID WHERE pit.TruckID=? ORDER BY pit.MainMark,pi.InstanceNumber",[load]);if(!(items as any[]).length)return response.status(400).json({error:'Add at least one assembly instance before creating a shipping ticket.'});const ticketNumber=`ST-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${randomBytes(3).toString('hex').toUpperCase()}`;const [ticket]=await mysqlConnection.query('INSERT INTO shipping_tickets (ticketNumber,jobNumber,contractorId,shippingDate,destination,remarks) VALUES (?,?,?,?,?,?)',[ticketNumber,job,cid,l.PlannedShipDate||null,request.body?.destination||null,`Load ${l.TruckNumber}`]);const ticketId=Number((ticket as any).insertId);for(const item of items as any[]){const qrCode=buildAssemblyQrCode(job,`${item.assemblyMark}-${item.InstanceNumber}`);await mysqlConnection.query('INSERT INTO shipping_ticket_items (shippingTicketId,qrCode,assemblyMark,quantity,weight) VALUES (?,?,?,?,?)',[ticketId,qrCode,item.assemblyMark,1,item.weight])}response.status(201).json({saved:true,ticketNumber,assemblyCount:(items as any[]).length})}catch(error){console.error('Unable to create load shipping ticket',error);response.status(500).json({error:'Unable to create the shipping ticket.'})}});
app.get('/api/instances', async (request, response, next) => {
  try {
    const status = request.query.status as FabricationStatus | undefined;
    const instances = await prisma.modelInstance.findMany({
      where: status && statuses.includes(status) ? { status } : undefined,
      orderBy: { updatedAt: 'desc' },
      select: instanceSelect
    });
    response.json({ instances: instances.map(presentInstance) });
  } catch (error) { next(error); }
});

app.post('/api/instances', async (request, response, next) => {
  try {
    const input = instanceInput.parse(request.body);
    const instance = await prisma.modelInstance.create({
      data: {
        ...input,
        status: (input.status as FabricationStatus | undefined) ?? FabricationStatus.PLANNED,
        history: { create: { toStatus: (input.status as FabricationStatus | undefined) ?? FabricationStatus.PLANNED, note: 'Instance created' } }
      },
      select: instanceSelect
    });
    response.status(201).json(presentInstance(instance));
  } catch (error) { next(error); }
});

async function findInstance(identifier: string) {
  return prisma.modelInstance.findFirst({
    where: { OR: [{ id: identifier }, { qrCode: identifier }] },
    select: instanceSelect
  });
}

app.get('/api/instances/:identifier', async (request, response, next) => {
  try {
    const instance = await findInstance(request.params.identifier);
    if (!instance) return response.status(404).json({ error: 'Model instance not found' });
    response.json(presentInstance(instance));
  } catch (error) { next(error); }
});

app.patch('/api/instances/:identifier/status', async (request, response, next) => {
  try {
    const input = statusInput.parse(request.body);
    const current = await findInstance(request.params.identifier);
    if (!current) return response.status(404).json({ error: 'Model instance not found' });
    if (current.status === input.status) return response.status(400).json({ error: 'Instance is already in that status' });

    const updated = await prisma.$transaction(async (transaction) => {
      await transaction.modelInstance.update({ where: { id: current.id }, data: { status: input.status as FabricationStatus } });
      await transaction.statusHistory.create({ data: { instanceId: current.id, fromStatus: current.status, toStatus: input.status as FabricationStatus, note: input.note, updatedBy: input.updatedBy } });
      return transaction.modelInstance.findUniqueOrThrow({ where: { id: current.id }, select: instanceSelect });
    });
    response.json(presentInstance(updated));
  } catch (error) { next(error); }
});

app.get('/api/instances/:identifier/history', async (request, response, next) => {
  try {
    const instance = await findInstance(request.params.identifier);
    if (!instance) return response.status(404).json({ error: 'Model instance not found' });
    const history = await prisma.statusHistory.findMany({ where: { instanceId: instance.id }, orderBy: { createdAt: 'desc' } });
    response.json({ history });
  } catch (error) { next(error); }
});

app.get('/api/instances/:identifier/qr', async (request, response, next) => {
  try {
    const instance = await findInstance(request.params.identifier);
    if (!instance) return response.status(404).json({ error: 'Model instance not found' });
    const scanUrl = `${publicAppUrl}/scan/${instance.qrCode}`;
    const png = await QRCode.toBuffer(scanUrl, { type: 'png', width: 600, margin: 2, errorCorrectionLevel: 'H' });
    response.type('png').send(png);
  } catch (error) { next(error); }
});

app.get('/api/instances/:identifier/print', async (request, response, next) => {
  try {
    const instance = await findInstance(request.params.identifier);
    if (!instance) return response.status(404).send('Model instance not found');
    const qrDataUrl = await QRCode.toDataURL(`${publicAppUrl}/scan/${instance.qrCode}`, { width: 420, margin: 2, errorCorrectionLevel: 'H' });
    response.type('html').send(`<!doctype html><html><head><title>QR label - ${instance.modelNumber}</title><style>body{font-family:Arial,sans-serif;text-align:center;margin:24px}.label{width:320px;border:2px solid #111;padding:18px;margin:auto}img{width:260px;height:260px}.model{font-size:22px;font-weight:700;margin:8px 0}.name{font-size:16px}button{padding:10px 18px;margin-top:18px}@media print{button{display:none}.label{border:0}}</style></head><body><div class="label"><img src="${qrDataUrl}" alt="QR code for ${instance.modelNumber}"><div class="model">${instance.modelNumber}</div><div class="name">${instance.name}</div><div>${instance.qrCode}</div></div><button onclick="print()">Print label</button></body></html>`);
  } catch (error) { next(error); }
});

app.get('/scan/:qrCode', (request, response) => response.redirect(`/api/instances/${encodeURIComponent(request.params.qrCode)}`));

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) return response.status(400).json({ error: 'Validation failed', details: error.issues });
  console.error(error);
  response.status(500).json({ error: 'Internal server error' });
});

ensureAssemblyScanTables().catch((error) => console.error('Unable to initialize assembly_scan_history tables', error));

if (process.env.BACKFILL_EXISTING_SCANS === 'true') {
  backfillHistoricalAssemblyScans().catch((error) => console.error('Unable to backfill historical assembly scans', error));
}

const server = app.listen(port, '0.0.0.0', () => console.log(`PowerFab API listening on ${publicAppUrl}`));

process.on('SIGINT', async () => { server.close(); await prisma.$disconnect(); });
process.on('SIGTERM', async () => { server.close(); await prisma.$disconnect(); });









