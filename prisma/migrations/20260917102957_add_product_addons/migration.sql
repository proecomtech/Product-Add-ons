-- CreateTable
CREATE TABLE "ShopSetting" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "onlineStorePublicationId" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AddonGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "heading" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "appliesTo" TEXT NOT NULL DEFAULT 'ALL',
    "targets" TEXT NOT NULL DEFAULT '[]',
    "selection" TEXT NOT NULL DEFAULT 'MULTI',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AddonOption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "productGid" TEXT,
    "variantGid" TEXT,
    "syncError" TEXT,
    "requiresShipping" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AddonOption_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AddonGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AddonField" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'TEXT',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "placeholder" TEXT,
    "helpText" TEXT,
    "choices" TEXT NOT NULL DEFAULT '[]',
    "maxLength" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AddonField_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AddonGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AddonGroup_shop_active_idx" ON "AddonGroup"("shop", "active");

-- CreateIndex
CREATE INDEX "AddonOption_groupId_idx" ON "AddonOption"("groupId");

-- CreateIndex
CREATE INDEX "AddonField_groupId_idx" ON "AddonField"("groupId");
