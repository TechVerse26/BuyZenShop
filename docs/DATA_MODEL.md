# Data model (Firestore) — what exists, who may touch it

`firestore.rules` is the single source of truth (scenario tests in `tests/rules`). This page is the readable
summary. Document ids in `code` style. "staff:perm" = active staff whose role has that permission (Super Admin has all).
All timestamps are Firestore Timestamps; writers use the `TS` sentinel (`js/shared/ops.js`) = `serverTimestamp()`.

## Staff, audit, settings, content
| Path | Shape | Read | Write |
|---|---|---|---|
| `staff/{uid}` | `{role, active, email, name, createdAt, updatedAt, createdBy}` (**only** these keys; role ∈ super_admin, store_admin, product_manager, order_manager, inventory_manager, customer_support, reporting) | self, staff:staff.manage | staff:staff.manage |
| `auditLogs/{id}` | `{actorUid, actorEmail, actorRole, action, entity, entityId, summary(≤600), before, after, createdAt}` | staff:audit.read | any active staff, create only (`auditOp(actor(), {...})`) |
| `activity_logs/{id}` | legacy log | staff:audit.read | never |
| `settings/public` | store name, tagline, logoUrl, contact{whatsapp,email,phone,address}, social{facebook,instagram,youtube,tiktok}, payments{cod,bkash,nagad:{enabled,number,accountType,note}}, checkout{returnWindowDays}, integrations{tawk}, announcement{enabled,text,link}, seo{title,description}, ui{banglaDigits}, orderPrefix | everyone | staff:settings.write |
| `settings/private` | `{lowStockThreshold, notifyEmails[], invoice{businessName,address,phone,note}}` | staff:settings.read | staff:settings.write |
| `meta/catalog` | `{version: ms, updatedAt}` — cache-busting stamp, `catalogStampOp(Date.now())` | everyone | any staff who writes catalog data |
| `content/home` | `{sections: Section[], updatedAt}` — see `js/shared/contentModel.js` | everyone | staff:content.write |
| `pages/{slug}` | `{title, body(markdown), visible, footer, sort, seoTitle, seoDescription, updatedAt}` | `visible==true` or staff:content.write | staff:content.write |
| `shippingZones/{id}` | `{name, districts[], fee, freeOver|null, etaMin, etaMax, active, sort, updatedAt}` | everyone | staff:shipping.write |

## Catalog
| Path | Shape | Read | Write |
|---|---|---|---|
| `categories/{id}` | `{name, slug, parentId|null, image, icon, description, sort, visible, createdAt, updatedAt}` | `visible==true` or staff:products.read | staff:categories.write |
| `brands/{id}` | `{name, slug, logo, description, visible, createdAt, updatedAt}` | `visible==true` or staff:products.read | staff:brands.write |
| `products/{id}` | see below (≤ 90 keys; `validProduct()` enforces name 1–200, slug `^[a-z0-9]+(-[a-z0-9]+)*$` ≤120, status ∈ draft/published/archived, type ∈ simple/variable, integer price 0–1e8, salePrice null or < price) | `status=='published'` or staff:products.read | staff:products.write (create/update), staff:products.delete; reviews moderators may update only `ratingAvg, ratingCount, ratingSum, updatedAt` |
| `productPrivate/{id}` | `{costPrice, supplier, notes}` | staff:costs.read | staff:products.write |
| `slugIndex/{slug}` → `{productId}`, `skuIndex/{sku}` → `{productId, variantId|null}` | uniqueness helpers | staff:products.read | staff:products.write |
| `inventory/{key}` | key = `productId` or `productId__variantId`. `{productId, variantId|null, categoryId, sku, price, salePrice|null, saleStart|null, saleEnd|null, stock, reserved, track, allowBackorder, maxPerOrder, active, lowStockThreshold, updatedAt}` — **authoritative price/stock used at checkout** | everyone | create/delete staff:products.write; update staff:products.write or inventory.adjust (always include `updatedAt`), staff:orders.update only `stock/reserved/lastOrderId/updatedAt`; customers only bump `reserved`+`lastOrderId` inside their order batch |
| `inventoryMovements/{id}` | `movementOp(...)`: `{key, productId, variantId, sku, type, delta, reservedDelta, refType, refId, note, stockAfter, actorUid, actorEmail, createdAt}` immutable | staff:inventory.read | staff:inventory.adjust or orders.update (create only) |
| `suppliers/{id}`, `purchases/{id}` | optional purchasing records (purchases immutable) | staff:inventory.read | staff:inventory.adjust |

Product document fields: `name, slug, status, type, categoryId, categoryName, brandId, brandName, price, salePrice, saleStart, saleEnd, sku,
images[{id,url,thumb,alt,w,h,path,thumbPath}] (≤12), icon, shortDescription, description(markdown), highlights[string], specs[{label,value}],
tags[string], options[{name, values[]}] (≤3), variants[{id, optionValues{[optionName]: value}, sku, image, active}] (≤40), featured, soldCount,
ratingAvg, ratingCount, ratingSum, seoTitle, seoDescription, createdAt, updatedAt, schemaVersion`. For `type:'variable'` every variant has its own
`inventory/{productId}__{variantId}` doc; simple products use `inventory/{productId}`. Legacy (pre-upgrade) products lack `status/type` and are adapted
at read time by `normalizeProduct` until the migration upgrades them.

## Marketing
| Path | Shape | Read | Write |
|---|---|---|---|
| `coupons/{CODE}` | `{code, type: percent|fixed|free_shipping, value, maxDiscount|null, minOrder, appliesTo: all|products|categories, productIds[], categoryIds[], excludeSaleItems, startsAt|null, endsAt|null, usageLimit|null, usedCount, perCustomerLimit|null, customerIds[], active, description, createdAt, updatedAt, lastOrderId}` | get: any signed-in user; list: staff:coupons.read | staff:coupons.write; customers only `usedCount+1` + `lastOrderId` inside their order batch |
| `couponUsage/{CODE__UID}` | `{code, userId, count, lastOrderId, updatedAt}` | owner (get), staff:coupons.read | customer at checkout; staff:coupons.write |
| `paymentTrx/{TRXID}` | `{orderId, userId, method, createdAt}` — a TrxID can belong to one order | staff:orders.read | customer at checkout; delete staff:payments.verify |

## Customers
| Path | Shape | Read | Write |
|---|---|---|---|
| `users/{uid}` | `{displayName, email, phone, photoURL, notifyPrefs, createdAt, lastLoginAt, updatedAt, defaultAddressId, lastOrderAt}` + staff flags `restricted, restrictedReason, restrictedAt` | owner, staff:customers.read (list too) | owner (profile keys; `lastOrderAt` only inside checkout, 15 s cooldown, blocked when `restricted`); staff:customers.write flags only |
| `users/{uid}/addresses/{id}` | `{label,name,phone,district,upazila,area,postalCode,line1,isDefault,updatedAt}` | owner only | owner |
| `users/{uid}/wishlist/{pid}` | `{productId, addedAt}` | owner | owner |
| `users/{uid}/cart/main` | `{items: {lineKey: qty}, updatedAt}` (≤60 lines) | owner | owner |
| `users/{uid}/notifications/{id}` | `{title, body, kind, orderNumber, read, createdAt}` | owner | create: staff (orders.update / support.reply); owner may only set `read`, or delete |
| `userPrivate/{uid}` | staff notes about a customer | staff:customers.read | staff:customers.write |
| `newsletter/{email}` | `{email, source, createdAt}` | staff:customers.read | anyone (create/update own shape), delete staff:customers.write |

## Orders
| Path | Shape | Read | Write |
|---|---|---|---|
| `orders/{SV-yymmdd-XXXXXX}` | schema v2: `{schemaVersion:2, orderNumber, userId, customer{name,phone,email}, address{name,phone,district,upazila,area,postalCode,line1,notes}, zoneId, zoneName, items{lineKey:{productId,variantId,sku,name,variantLabel,unitPrice,regularPrice,qty,lineTotal,image,categoryId}}, itemOrder[lineKey] (1–5), totals{subtotal,eligibleSubtotal,discount,shipping,tax:0,total}, couponCode, payment{method:cod|bkash|nagad, status, trxId, senderNumber, amountDue [+receivedAmount, verifiedAt, verifiedBy, failReason, collectedAt]}, status, notes{customer}, createdAt, updatedAt [+ shipping{carrier,trackingNo,trackingUrl}, refund{amount,method,at,by}, confirmedAt, shippedAt, deliveredAt, cancelledAt, cancelReason, returnRequestedAt]}`. Legacy orders (no schemaVersion; items array, `timestamp`, `totalAmount`…) are read through `normalizeOrder`. | owner, staff:orders.read | create: customer only via `placeOrder` (rules re-derive prices/totals/shipping/coupon from catalog docs in the same batch); customer: cancel pending-unpaid, request return of delivered, resubmit TrxID after failed payment; staff:orders.update (status per transition table; payment needs payments.verify/orders.refund; cancel needs orders.cancel) |
| `orders/{id}/events/{eid}` | `timelineOp`: `{type, status, note, visibility: customer|internal, userId, actorUid, actorRole, createdAt}` immutable | owner (visibility `customer`), staff:orders.read | staff:orders.update or support.reply (create) |
| `orderPrivate/{id}` | internal staff notes | staff:orders.read | staff:orders.update |
| `returns/{orderNumber}` | `{orderNumber, userId, lines[], reason, details, status, createdAt, updatedAt}` | owner, staff:orders.read | customer creates (with the order status flip in the same batch); staff:orders.update |
| `refunds/{id}` | `{orderNumber, userId, amount, method, note, actorUid, createdAt}` | owner, staff:orders.read | staff:orders.refund |

Order lifecycle: pending → confirmed → processing → packed → shipped → delivered; side exits cancelled / return_requested → returned → refund_pending → refunded.
Stock: reserved at placement; physically deducted when shipped (or delivered if never shipped); released on pre-ship cancel; optional restock on return.
Use the planners in `js/shared/orderFlow.js` (`planStatusChange`, `planPaymentAction`, `planRefund`, `planReservationRecount`) — never hand-write order updates.

## Reviews, support, mail
| Path | Shape | Read | Write |
|---|---|---|---|
| `reviews/{PRODUCTID__UID}` | `{productId,userId,userName,rating 1–5,title,text,status: pending|approved|rejected,verified,orderNumber,lineKey,helpfulCount,createdAt,updatedAt}` | approved, own, staff:reviews.moderate | customer creates `pending` (verified only for a delivered order that contains the product), edits own pending, +1 helpful once (`reviews/{id}/votes/{uid}`), deletes own pending; staff:reviews.moderate anything |
| `reviewReports/{reviewId__uid}` | `{reviewId, productId, reporterId, reason, createdAt}` | staff:reviews.moderate | signed-in create; staff:reviews.moderate update/delete |
| `supportTickets/{TK-yymmdd-XXXXXX}` | `{userId|null, name, email, phone, subject, message, orderNumber, status: open|…, priority, lastAuthor: customer|staff, createdAt, updatedAt}` | owner, staff:support.read | create: anyone (guests have `userId:null`); owner may re-open (`status/lastAuthor/updatedAt`); staff:support.reply anything |
| `supportTickets/{id}/messages/{mid}` | `{authorType: customer|staff, authorUid, text, createdAt}` immutable | owner, staff:support.read | owner (customer messages), staff:support.reply (staff messages) |
| `mail/{id}` | outbox for the optional "Trigger Email from Firestore" extension (`{to, message:{subject,text,html}}`) | staff:mail.send | staff:mail.send (create only) |

## Query rules of thumb (these decide whether a page works in production)
* **Rules are not filters.** A list query is allowed only if the query's own constraints prove every possible result is readable:
  public lists must carry `where('status','==','published')` (products) or `where('visible','==',true)` (categories, brands, pages);
  customers list their orders with `where('userId','==',uid)`; order events need `userId` and `visibility` equality filters;
  product reviews need `productId` + `status=='approved'` equality filters. Staff with the permission may list unconstrained.
* **No composite indexes** (`firestore.indexes.json` is empty): use only equality filters with no `orderBy`, or a single `orderBy` with no filter
  (or an inequality on that same field). Sort/filter the rest in the browser. `where('a','==',x).orderBy('b')` WILL fail in production.
* Documents lacking a field are skipped by `orderBy` on that field; legacy orders have `timestamp` instead of `createdAt` (admin runs two queries and merges — see `js/data/ordersAdmin.js`).
* A `get` of a missing/hidden doc is *denied*, not "not found" → use `getDocDataSafe`.
* Atomic batches: ≤ 20 rule access calls; keep staff batches ≤ 18 ops (`commitAtomic` throws above 20, `commitChunked` splits bulk jobs into independent atomic chunks — only for idempotent jobs).
  Every staff write of catalog data also writes `catalogStampOp(Date.now())`; every staff action writes an `auditOp(...)`; staff inventory writes include `updatedAt`.
