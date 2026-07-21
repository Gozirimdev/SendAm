-- AlterTable
ALTER TABLE "User" ADD COLUMN     "awaitingGetStartedUntil" TIMESTAMP(3),
ADD COLUMN     "registrationToken" TEXT,
ADD COLUMN     "registrationTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_registrationToken_key" ON "User"("registrationToken");
