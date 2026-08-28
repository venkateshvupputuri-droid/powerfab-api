import { PrismaClient, FabricationStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.modelInstance.deleteMany();
  await prisma.modelInstance.createMany({
    data: [
      { modelNumber: 'PF-1001', assemblyNumber: 'ASM-001', name: 'Frame Assembly A', description: 'Main structural frame', site: 'GPVC', projectName: '601AD-LC-0766', plant: 'VCM', unit: '601', jobNumber: '601', location: 'Bay 1', status: FabricationStatus.IN_PROGRESS },
      { modelNumber: 'PF-1002', assemblyNumber: 'ASM-002', name: 'Access Platform B', description: 'Service access platform', site: 'GPVC', projectName: '601AD-LC-0766', plant: 'VCM', unit: '601', jobNumber: '601', location: 'Bay 2', status: FabricationStatus.QUALITY_CHECK },
      { modelNumber: 'PF-1003', assemblyNumber: 'ASM-003', name: 'Support Bracket C', description: 'Heavy-duty support bracket', site: 'GPVC', projectName: '601AD-LC-0766', plant: 'VCM', unit: '601', jobNumber: '601', location: 'Bay 1', status: FabricationStatus.PLANNED },
      { modelNumber: 'PF-2001', assemblyNumber: 'ASM-004', name: 'South Platform Frame', description: 'Secondary platform frame', site: 'GPVC', projectName: '601AD-LC-0766', plant: 'CAC', unit: '301', jobNumber: '301', location: 'Bay 3', status: FabricationStatus.PLANNED }
    ]
  });
}

main().finally(() => prisma.$disconnect());
