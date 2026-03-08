/*
  Warnings:

  - A unique constraint covering the columns `[docId,version]` on the table `Operation` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Operation_docId_version_key" ON "Operation"("docId", "version");
