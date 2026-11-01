import assert from "node:assert/strict";
import test from "node:test";
import { txtRecord } from "./dns-names.js";

test("主域名和子域名的 TXT 主机记录", () => {
  assert.deepEqual(txtRecord("example.com", "example.com"), {
    rr: "_acme-challenge",
    fqdn: "_acme-challenge.example.com",
  });
  assert.deepEqual(txtRecord("www.example.com", "example.com"), {
    rr: "_acme-challenge.www",
    fqdn: "_acme-challenge.www.example.com",
  });
  assert.deepEqual(txtRecord("*.example.com", "example.com"), {
    rr: "_acme-challenge",
    fqdn: "_acme-challenge.example.com",
  });
});

test("不在解析区下的域名会拒绝", () => {
  assert.throws(() => txtRecord("www.other.com", "example.com"), /不在解析区/);
});
