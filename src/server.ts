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

const prisma = new PrismaClient();
const app = express();
const port = Number(process.env.PORT ?? 3000);
const publicAppUrl = process.env.PUBLIC_APP_URL ?? `http://localhost:${port}`;
const powerFabDrawingsUrlTemplate = process.env.POWERFAB_DRAWINGS_URL_TEMPLATE ?? 'https://adani.teklapowerfab.net/pdc-job-overview?ProductionControlID={productionControlId}#sectionDrawings';
const drawingsRoot = process.env.POWERFAB_DRAWINGS_ROOT ?? '';
const contractorSessions = new Map<string, { contractorId: number; expiresAt: number }>();

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
app.use(express.json());
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
      active BOOLEAN NOT NULL DEFAULT TRUE,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

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
    CREATE TABLE IF NOT EXISTS contractor_fitup_inspections (
      id BIGINT NOT NULL AUTO_INCREMENT,
      contractorId BIGINT NOT NULL,
      qrCode VARCHAR(255) NOT NULL,
      jobNumber VARCHAR(255) NOT NULL,
      assemblyMark VARCHAR(255) NOT NULL,
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

  const bootstrapUsername = String(process.env.CONTRACTOR_BOOTSTRAP_USERNAME ?? '').trim();
  const bootstrapPassword = String(process.env.CONTRACTOR_BOOTSTRAP_PASSWORD ?? '');
  const bootstrapName = String(process.env.CONTRACTOR_BOOTSTRAP_NAME ?? '').trim();
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
}

function buildAssemblyQrCode(jobNumber: string, assemblyKey: string | number) {
  const base = `${String(jobNumber || 'powerfab').replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}-${String(assemblyKey || 'assembly')}`;
  return `pf-${createHash('sha256').update(base).digest('hex').slice(0, 12)}`;
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

      const candidateQr = buildAssemblyQrCode(jobNumber, assemblyId);
      if (candidateQr === normalizedQrCode) {
        return {
          jobNumber,
          productionControlID: productionControlId,
          productionControlAssemblyID: Number(assemblyId),
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
        ProductionSurfaceAreaEach = VALUES(ProductionSurfaceAreaEach)` ,
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
  }
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
  checks: z.record(z.string(), z.enum(['PASS', 'FAIL', 'N/A'])).optional()
});

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
    await mysqlConnection.query(
      'INSERT INTO contractor_users (username, passwordHash, contractorName, active) VALUES (?, ?, ?, TRUE) ON DUPLICATE KEY UPDATE contractorName = VALUES(contractorName), active = TRUE',
      [powerFabUser.Username, hashContractorPassword(randomBytes(32).toString('hex')), contractorName]
    );
    const [contractorRows] = await mysqlConnection.query('SELECT id, username, contractorName FROM contractor_users WHERE username = ? AND active = TRUE LIMIT 1', [powerFabUser.Username]);
    contractor = (contractorRows as Array<Record<string, any>>)[0];
  } else {
    const [rows] = await mysqlConnection.query('SELECT id, username, contractorName, passwordHash FROM contractor_users WHERE username = ? AND active = TRUE LIMIT 1', [input.data.username]);
    const localContractor = (rows as Array<Record<string, any>>)[0];
    if (localContractor && verifyContractorPassword(input.data.password, localContractor.passwordHash)) contractor = localContractor;
  }
  if (!contractor) return response.status(401).json({ error: 'Invalid contractor login.' });
  const token = randomBytes(32).toString('hex');
  contractorSessions.set(token, { contractorId: Number(contractor.id), expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  response.setHeader('Set-Cookie', `powerfab_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
  response.json({ contractor: { username: contractor.username, contractorName: contractor.contractorName } });
});

app.post('/api/auth/logout', (request, response) => {
  contractorSessions.delete(getSessionToken(request));
  response.setHeader('Set-Cookie', 'powerfab_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  response.json({ ok: true });
});

app.get('/api/auth/me', async (request, response) => {
  const contractorId = getContractorId(request);
  if (!contractorId) return response.status(401).json({ error: 'Contractor login required.' });
  const [rows] = await mysqlConnection.query('SELECT username, contractorName FROM contractor_users WHERE id = ? AND active = TRUE LIMIT 1', [contractorId]);
  const contractor = (rows as Array<Record<string, any>>)[0];
  if (!contractor) return response.status(401).json({ error: 'Contractor login required.' });
  response.json({ contractor });
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
        return `SELECT p.${jobColumn} AS jobNumber, p.${descriptionColumn} AS description, p.${siteColumn} AS site, p.${plantColumn} AS plant, p.${unitColumn} AS unit, p.${locationColumn} AS location, COALESCE(js.Description, 'PLANNED') AS status, p.${updatedAtColumn} AS updatedAt FROM \`${tableName}\` p LEFT JOIN jobstatuses js ON js.JobStatusID = p.${statusColumn} ORDER BY p.${updatedAtColumn} DESC LIMIT 200`;
      }

      return `SELECT ${jobColumn} AS jobNumber, ${descriptionColumn} AS description, ${siteColumn} AS site, ${plantColumn} AS plant, ${unitColumn} AS unit, ${locationColumn} AS location, ${statusColumn} AS status, ${updatedAtColumn} AS updatedAt FROM \`${tableName}\` ORDER BY ${updatedAtColumn} DESC LIMIT 200`;
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
    const [assignedRows] = await mysqlConnection.query('SELECT jobNumber FROM contractor_project_assignments WHERE contractorId = ?', [contractorId]);
    const assignedJobs = new Set((assignedRows as Array<Record<string, any>>).map((row) => String(row.jobNumber)));
    const projects = (await loadProjectsFromDatabase()).filter((project) => assignedJobs.has(String(project.jobNumber)));
    response.json({ projects });
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
    if (token) contractorSessions.delete(token);
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

async function contractorCanSubmitFitupInspection(contractorId: number) {
  const [rows] = await mysqlConnection.query(
    `SELECT u.ExternalUser
     FROM contractor_users cu
     JOIN users u ON u.Username = cu.username AND u.Active = 1
     WHERE cu.id = ? AND cu.active = TRUE
     LIMIT 1`,
    [contractorId]
  );
  const user = (rows as Array<Record<string, any>>)[0];
  if (!user || !Boolean(user.ExternalUser)) return true;

  const [permissionRows] = await mysqlConnection.query(
    `SELECT 1
     FROM contractor_users cu
     JOIN users u ON u.Username = cu.username AND u.Active = 1
     JOIN useraccess ua ON ua.UserID = u.UserID
     WHERE cu.id = ? AND ua.Type = 'INSP' AND CAST(ua.Value AS UNSIGNED) = 1
     LIMIT 1`,
    [contractorId]
  );
  return (permissionRows as Array<Record<string, any>>).length > 0;
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

      return {
        productionControlAssemblyId,
        mainMark: cleanPowerFabValue(row.MainMark ?? '—'),
        drawingNumber: cleanPowerFabValue(row.MainMark ?? '—'),
        assemblyQuantity: qty,
        totalQty: qty,
        weight,
        assemblyWeightEach: weight,
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
    const rfiCount = projectId ? await getSingleValue('SELECT COUNT(*) AS total FROM `requestforinformationdrawings` WHERE `ProjectID` = ?', [projectId]) : 0;
    const transmittalCount = projectId ? await getSingleValue('SELECT COUNT(*) AS total FROM `drawingtransmittals` WHERE `DrawingID` IN (SELECT `DrawingID` FROM `drawings` WHERE `ProjectID` = ?)', [projectId]) : 0;

    const detail = {
      jobNumber: project.JobNumber ?? jobNumber,
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
        d.Description,
        d.ApprovalStatusID,
        COALESCE(aps.Description, '—') AS approvalStatus,
        COALESCE(dr.Revision, '—') AS revision,
        COALESCE((SELECT SUM(pca.AssemblyQuantity)
          FROM productioncontrolitems pci
          JOIN productioncontrolassemblies pca ON pca.ProductionControlAssemblyID = pci.ProductionControlAssemblyID
          WHERE pci.DrawingID = d.DrawingID AND pci.ProductionControlID = ?), 0) AS assemblyQuantity,
        COALESCE((SELECT SUM(pci.Weight * pci.Quantity)
          FROM productioncontrolitems pci
          WHERE pci.DrawingID = d.DrawingID AND pci.ProductionControlID = ?), 0) AS weight,
        COALESCE((SELECT MIN(pcs.SequenceID)
          FROM productioncontrolitems pci
          JOIN productioncontrolsequences pcs ON pcs.ProductionControlID = pci.ProductionControlID
          WHERE pci.DrawingID = d.DrawingID AND pci.ProductionControlID = ?), '—') AS sequence
      FROM drawings d
      LEFT JOIN drawingrevisions dr ON dr.DrawingRevisionID = d.LatestDrawingRevisionID
      LEFT JOIN approvalstatuses aps ON aps.ApprovalStatusID = d.ApprovalStatusID
      WHERE d.ProjectID = ?
      ORDER BY d.DrawingNumber
      LIMIT 2000`,
      [productionControlId, productionControlId, productionControlId, Number(project.ProjectID)]
    );

    response.json({
      jobNumber: project.JobNumber,
      drawings: (drawingRows as Array<Record<string, any>>).map((drawing) => ({
        drawingId: Number(drawing.DrawingID),
        drawingNumber: cleanPowerFabValue(drawing.DrawingNumber),
        drawingLog: 'Drawing',
        revision: cleanPowerFabValue(drawing.revision),
        description: cleanPowerFabValue(drawing.Description),
        approvalStatus: cleanPowerFabValue(drawing.approvalStatus),
        assemblyQuantity: Number(drawing.assemblyQuantity ?? 0),
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
              COALESCE(dr.Revision, '—') AS revision,
              COALESCE(aps.Description, '—') AS approvalStatus,
              (SELECT MIN(pca.ProductionControlAssemblyID)
               FROM productioncontrolitems pci
               JOIN productioncontrolassemblies pca
                 ON pca.ProductionControlID = pci.ProductionControlID
                AND pca.ProductionControlAssemblyID = pci.ProductionControlAssemblyID
               WHERE pci.DrawingID = d.DrawingID
                 AND pci.ProductionControlID = ?) AS productionControlAssemblyID
       FROM drawingtransmittals dt
       JOIN transmittals t ON t.TransmittalID = dt.TransmittalID
       JOIN drawings d ON d.DrawingID = dt.DrawingID
       LEFT JOIN drawingrevisions dr ON dr.DrawingRevisionID = COALESCE(dt.DrawingRevisionID, d.LatestDrawingRevisionID)
       LEFT JOIN approvalstatuses aps ON aps.ApprovalStatusID = d.ApprovalStatusID
       WHERE dt.TransmittalID = ? AND t.ProjectID = ?
       ORDER BY d.DrawingNumber
       LIMIT 2000`,
      [productionControlId, transmittalId, Number(context.project.ProjectID)]
    );

    response.json({
      jobNumber: context.jobNumber,
      transmittalId,
      drawings: (drawingRows as Array<Record<string, any>>).map((drawing) => ({
        drawingId: Number(drawing.DrawingID),
        drawingNumber: cleanPowerFabValue(drawing.DrawingNumber),
        description: cleanPowerFabValue(drawing.Description),
        revision: cleanPowerFabValue(drawing.revision),
        approvalStatus: cleanPowerFabValue(drawing.approvalStatus),
        qrCode: drawing.productionControlAssemblyID
          ? buildAssemblyQrCode(context.jobNumber, Number(drawing.productionControlAssemblyID))
          : '',
        qrUrl: drawing.productionControlAssemblyID
          ? `/api/assemblies/${encodeURIComponent(buildAssemblyQrCode(context.jobNumber, Number(drawing.productionControlAssemblyID)))}/qr`
          : `/api/drawings/${Number(drawing.DrawingID)}/qr?job=${encodeURIComponent(context.jobNumber)}`,
        qrType: drawing.productionControlAssemblyID ? 'assembly' : 'drawing'
      }))
    });
  } catch (error) {
    console.error('Unable to load transmittal drawings', error);
    response.status(500).json({ error: 'Failed to load drawings assigned to this transmittal.' });
  }
});

app.get('/api/project-inspections', async (request, response) => {
  const context = await getAuthorizedProject(request, response);
  if (!context) return;
  const [powerFabRows] = await mysqlConnection.query(
    `SELECT itr.InspectionTestRecordID, itr.TestDateTime, itr.TestUpdatedDateTime,
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
    [await getSingleValue('SELECT ProductionControlID FROM productioncontroljobs WHERE JobNumber = ? LIMIT 1', [context.jobNumber])]
  );
  const [portalRows] = await mysqlConnection.query(
    `SELECT id, qrCode, assemblyMark, result, inspector, remarks, createdAt
     FROM contractor_fitup_inspections WHERE jobNumber = ? ORDER BY createdAt DESC LIMIT 1000`,
    [context.jobNumber]
  );
  response.json({ jobNumber: context.jobNumber, powerFabInspections: powerFabRows, contractorInspections: portalRows });
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
    const scanUrl = `${publicAppUrl}/scan.html?qr=${encodeURIComponent(qrCode)}`;
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
  const [contractorRows] = await mysqlConnection.query('SELECT contractorName FROM contractor_users WHERE id = ? LIMIT 1', [contractorId]);
  const assignedContractor = (contractorRows as Array<Record<string, any>>)[0]?.contractorName ?? '';

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
  const currentStage = history[0]?.stage ?? 'Fitup';
  response.json({
    qrCode,
    currentStage,
    jobNumber: history[0]?.jobNumber || assemblyMatch?.jobNumber || '',
    assemblyMark: history[0]?.assemblyMark || assemblyMatch?.assemblyMark || '',
    contractorName: assignedContractor,
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
    history
  });
});

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
  if (!(await contractorCanSubmitFitupInspection(contractorId))) return response.status(403).json({ error: 'Fit-up inspection permission is not granted in PowerFab.' });

  const [result] = await mysqlConnection.query(
    `INSERT INTO contractor_fitup_inspections (contractorId, qrCode, jobNumber, assemblyMark, result, inspector, remarks, checks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [contractorId, qrCode, assembly.jobNumber, assembly.assemblyMark, input.data.result, input.data.inspector, input.data.remarks ?? null, JSON.stringify(input.data.checks ?? {})]
  );
  response.status(201).json({ saved: true, inspectionId: (result as any).insertId, result: input.data.result });
});

app.get('/api/assemblies/:qrCode/fitup-inspections', async (request, response) => {
  const qrCode = String(request.params.qrCode || '').trim();
  const contractorId = getContractorId(request);
  if (!contractorId) return response.status(401).json({ error: 'Contractor login required.' });
  if (!(await contractorCanAccessQr(contractorId, qrCode))) return response.status(403).json({ error: 'Assembly is not assigned to this contractor.' });
  const [rows] = await mysqlConnection.query('SELECT id, result, inspector, remarks, checks, createdAt FROM contractor_fitup_inspections WHERE qrCode = ? ORDER BY createdAt DESC', [qrCode]);
  response.json({ inspections: rows });
});

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

const server = app.listen(port, '0.0.0.0', () => console.log(`PowerFab API listening on ${publicAppUrl}`));

process.on('SIGINT', async () => { server.close(); await prisma.$disconnect(); });
process.on('SIGTERM', async () => { server.close(); await prisma.$disconnect(); });
