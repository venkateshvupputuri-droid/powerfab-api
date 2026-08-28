import { PrismaClient, FabricationStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.modelInstance.deleteMany();
  await prisma.modelInstance.createMany({
    data: [
      { modelNumber: 'PF-1001', name: 'Frame Assembly A', description: 'Main structural frame', location: 'Bay 1', status: FabricationStatus.IN_PROGRESS },
      { modelNumber: 'PF-1002', name: 'Access Platform B', description: 'Service access platform', location: 'Bay 2', status: FabricationStatus.QUALITY_CHECK },
      { modelNumber: 'PF-1003', name: 'Support Bracket C', description: 'Heavy-duty support bracket', location: 'Bay 1', status: FabricationStatus.PLANNED }
    ]
  });
}

main().finally(() => prisma.$disconnect());
