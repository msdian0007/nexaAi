// Real JWT/password/auth routes and durable PostgreSQL revocation. No AI/Redis.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { once } = require("node:events");
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const prisma = require("../dist/src/config/database").default;
const publicRoutes = require("../dist/src/auth/auth.routes").default;
const { authJsonError } = require("../dist/src/auth/auth.routes");
const protectedRoutes =
  require("../dist/src/auth/auth.protected.route").default;

test(
  "session lifetime, durable logout, current roles and membership recovery",
  { timeout: 60000 },
  async (t) => {
    const userId = randomUUID(),
      org = randomUUID(),
      other = randomUUID();
    const originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = randomUUID();
    const email = `${userId}@example.invalid`,
      password = "SessionFixture123!";
    const identity = { userId, organizationId: org, role: "OWNER" };
    const originalLookup = prisma.revokedToken.findUnique;
    const originalUpsert = prisma.revokedToken.upsert;
    let server;
    try {
      await prisma.user.create({
        data: {
          id: userId,
          name: "Session fixture",
          email,
          password: await bcrypt.hash(password, 4),
        },
      });
      for (const id of [org, other])
        await prisma.organization.create({
          data: { id, name: "Session fixture", slug: `sessions-${id}` },
        });
      for (const [organizationId, offset] of [
        [org, 0],
        [other, 1],
      ])
        await prisma.organizationMember.create({
          data: {
            userId,
            organizationId,
            role: "OWNER",
            createdAt: new Date(Date.now() + offset * 1000),
          },
        });
      const app = express();
      app.use(express.json());
      app.use("/auth", publicRoutes, protectedRoutes, authJsonError);
      server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      async function call(
        path,
        token,
        body,
        method = body === undefined ? "GET" : "POST",
      ) {
        const response = await fetch(
          `http://127.0.0.1:${server.address().port}/auth${path}`,
          {
            method,
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
          },
        );
        assert.equal(response.headers.get("cache-control"), "no-store");
        return { status: response.status, body: await response.json() };
      }
      const login = async () => {
        const result = await call("/login", null, { email, password });
        assert.equal(result.status, 200);
        return result.body.data;
      };
      let first, second;
      await t.test(
        "issued sessions have distinct IDs and authoritative expiry metadata",
        async () => {
          first = await login();
          second = await login();
          assert.notEqual(first.token, second.token);
          const decoded = jwt.verify(first.token, process.env.JWT_SECRET);
          assert.match(decoded.jti, /^[0-9a-f-]{36}$/);
          assert.equal(
            first.expiresAt,
            new Date(decoded.exp * 1000).toISOString(),
          );
          const me = await call("/me", first.token);
          assert.equal(me.status, 200);
          assert.equal(me.body.data.expiresAt, first.expiresAt);
        },
      );
      await t.test(
        "invalid signatures, missing expiry, malformed identities and wrong algorithms fail before DB lookup",
        async () => {
          let lookups = 0;
          prisma.revokedToken.findUnique = async () => {
            lookups++;
            throw new Error("must not read");
          };
          try {
            for (const token of [
              null,
              "invalid",
              jwt.sign(identity, "other-secret", { expiresIn: "5m" }),
              jwt.sign(identity, process.env.JWT_SECRET),
              jwt.sign({ ...identity, userId: "bad" }, process.env.JWT_SECRET, {
                expiresIn: "5m",
              }),
              jwt.sign(identity, process.env.JWT_SECRET, {
                algorithm: "HS384",
                expiresIn: "5m",
              }),
            ])
              assert.equal((await call("/me", token)).status, 401);
            const expired = jwt.sign(identity, process.env.JWT_SECRET, {
              expiresIn: -1,
            });
            const response = await call("/me", expired);
            assert.equal(response.status, 401);
            assert.equal(response.body.code, "SESSION_EXPIRED");
            assert.equal(lookups, 0);
          } finally {
            prisma.revokedToken.findUnique = originalLookup;
          }
        },
      );
      await t.test(
        "current database role controls role middleware despite a stale OWNER token",
        async () => {
          assert.equal((await call("/admin-test", first.token)).status, 200);
          await prisma.organizationMember.update({
            where: { userId_organizationId: { userId, organizationId: org } },
            data: { role: "MEMBER" },
          });
          assert.equal((await call("/admin-test", first.token)).status, 403);
          assert.equal(
            (await call("/me", first.token)).body.data.role,
            "MEMBER",
          );
          await prisma.organizationMember.update({
            where: { userId_organizationId: { userId, organizationId: org } },
            data: { role: "ADMIN" },
          });
          assert.equal(
            (await call("/admin-test", first.token)).body.data.role,
            "ADMIN",
          );
        },
      );
      await t.test(
        "revocation-store failure denies access safely without pretending expiry",
        async () => {
          prisma.revokedToken.findUnique = async () => {
            throw new Error("private SQL password");
          };
          try {
            const result = await call("/me", first.token);
            assert.equal(result.status, 503);
            assert.equal(result.body.code, "SESSION_UNAVAILABLE");
            assert.equal(JSON.stringify(result).includes("private"), false);
          } finally {
            prisma.revokedToken.findUnique = originalLookup;
          }
          assert.equal((await call("/me", first.token)).status, 200);
        },
      );
      await t.test(
        "logout accepts no identity overrides and never revokes on invalid input",
        async () => {
          for (const body of [{ userId }, { token: second.token }, [], null])
            assert.equal(
              (await call("/logout", first.token, body)).status,
              400,
            );
          assert.equal(
            (await call("/logout?organizationId=" + other, first.token, {}))
              .status,
            400,
          );
          assert.equal(
            await prisma.revokedToken.count({ where: { userId } }),
            0,
          );
        },
      );
      await t.test(
        "failed logout is explicit and can be retried; only fingerprints are retained",
        async () => {
          prisma.revokedToken.upsert = async () => {
            throw new Error("private database failure");
          };
          try {
            assert.equal((await call("/logout", first.token, {})).status, 503);
          } finally {
            prisma.revokedToken.upsert = originalUpsert;
          }
          assert.equal((await call("/me", first.token)).status, 200);
          const response = await call("/logout", first.token, {});
          assert.equal(response.status, 200);
          assert.deepEqual(response.body.data, { signedOut: true });
          const rows = await prisma.revokedToken.findMany({
            where: { userId },
          });
          assert.equal(rows.length, 1);
          assert.equal(
            rows[0].tokenHash,
            createHash("sha256").update(first.token).digest("hex"),
          );
          assert.equal(rows[0].expiresAt.toISOString(), first.expiresAt);
          assert.equal(JSON.stringify(rows).includes(first.token), false);
        },
      );
      await t.test(
        "replaying a logged-out token fails while a separate login remains valid",
        async () => {
          const replay = await call("/me", first.token);
          assert.equal(replay.status, 401);
          assert.equal(replay.body.code, "SESSION_REVOKED");
          assert.equal((await call("/organizations", first.token)).status, 401);
          assert.equal((await call("/logout", first.token, {})).status, 401);
          assert.equal((await call("/me", second.token)).status, 200);
          // A new real login remains independent, even in the same second.
          assert.equal((await call("/me", (await login()).token)).status, 200);
        },
      );
      await t.test(
        "removed organization access is distinct from expiry; account recovery and logout remain available",
        async () => {
          await prisma.organizationMember.delete({
            where: { userId_organizationId: { userId, organizationId: org } },
          });
          const me = await call("/me", second.token);
          assert.equal(me.status, 403);
          assert.equal(me.body.code, "ORGANIZATION_ACCESS_REVOKED");
          assert.equal((await call("/admin-test", second.token)).status, 403);
          assert.deepEqual(
            (await call("/organizations", second.token)).body.data.map(
              (c) => c.organization.id,
            ),
            [other],
          );
          const switched = await call("/switch-organization", second.token, {
            organizationId: other,
          });
          assert.equal(switched.status, 200);
          assert.equal(
            (await call("/me", switched.body.data.token)).body.data
              .organizationId,
            other,
          );
          assert.equal((await call("/logout", second.token, {})).status, 200);
          assert.equal(
            (await call("/me", switched.body.data.token)).status,
            200,
          );
        },
      );
    } finally {
      prisma.revokedToken.findUnique = originalLookup;
      prisma.revokedToken.upsert = originalUpsert;
      if (server) await new Promise((resolve) => server.close(resolve));
      try {
        await prisma.organization.deleteMany({
          where: { id: { in: [org, other] } },
        });
        await prisma.user.deleteMany({ where: { id: userId } });
        assert.equal(await prisma.revokedToken.count({ where: { userId } }), 0);
      } finally {
        if (originalSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = originalSecret;
        await prisma.$disconnect();
      }
    }
  },
);
