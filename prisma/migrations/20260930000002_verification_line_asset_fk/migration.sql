-- AddForeignKey
ALTER TABLE "verification_lines" ADD CONSTRAINT "verification_lines_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

