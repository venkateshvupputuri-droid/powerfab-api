import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { PrismaClient, FabricationStatus } from '@prisma/client';
import QRCode from 'qrcode';
import { z } from 'zod';

const prisma = new PrismaClient();
const app = express();
const port = Number(process.env.PORT ?? 3000);
const publicAppUrl = process.env.PUBLIC_APP_URL ?? `http://localhost:${port}`;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const statuses = Object.values(FabricationStatus);
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

const server = app.listen(port, () => console.log(`PowerFab API listening on ${publicAppUrl}`));

process.on('SIGINT', async () => { server.close(); await prisma.$disconnect(); });
process.on('SIGTERM', async () => { server.close(); await prisma.$disconnect(); });
