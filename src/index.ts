import dotenv from "dotenv";
dotenv.config();

import {
  Config,
  CourseConfig,
  Drive,
  TauLatest,
  Course,
} from "@taubyte/spore-drive";


import { Droplets, DropletInfo } from "./do";
import NamecheapDnsClient from "./namecheap";

import { fileURLToPath } from "url";
import path from "path";

import { existsSync, mkdirSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { ProgressBar } from "@opentf/cli-pbar";

const DOMAIN = process.env.DOMAIN!;
const DOMAIN_GENERATED = process.env.DOMAIN_GENERATED!;
const DROPLET_ROOT_PASSWORD = process.env.DROPLET_ROOT_PASSWORD!;
const NAMECHEAP_USERNAME = process.env.NAMECHEAP_USERNAME;
const NAMECHEAP_API_KEY = process.env.NAMECHEAP_API_KEY;
const NAMECHEAP_IP = process.env.NAMECHEAP_IP;

function extractHost(path: string): string {
  const match = path.match(/\/([^\/]+):\d+/);
  return match ? match[1] : "unknown-host";
}

function extractTask(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || "unknown-task";
}

async function displayProgress(course: Course) {
  const multiPBar = new ProgressBar({ size: "SMALL" });
  multiPBar.start();
  const taskBars: Record<string, any> = {};
  const errors: { host: string; task: string; error: string }[] = [];

  for await (const displacement of await course.progress()) {
    const host = extractHost(displacement.path);
    const task = extractTask(displacement.path);

    if (!taskBars[host]) {
      taskBars[host] = multiPBar.add({
        prefix: host,
        suffix: "...",
        total: 100,
      });
    }

    taskBars[host].update({ value: displacement.progress, suffix: task });

    if (displacement.error) {
      errors.push({ host, task, error: displacement.error });
    }
  }

  for (const host in taskBars) {
    const errorForHost = errors.find((err) => err.host === host);

    if (errorForHost) {
      taskBars[host].update({ value: 100, color: "r", suffix: "failed" });
    } else {
      taskBars[host].update({ value: 100, suffix: "succesful" });
    }
  }

  multiPBar.stop();

  if (errors.length > 0) {
    console.log("\nErrors encountered:");
    errors.forEach((err) => {
      console.log(`Host: ${err.host}, Task: ${err.task}, Error: ${err.error}`);
    });
    throw new Error("displacement failed");
  }
}

export const createConfig = async (config: Config) => {
  await config.cloud.domain.root.set(DOMAIN);
  await config.cloud.domain.generated.set(DOMAIN_GENERATED);

  try {
    await config.cloud.domain.validation.keys.data.privateKey.get();
  } catch {
    await config.cloud.domain.validation.generate();
  }

  try {
    await config.cloud.p2p.swarm.key.data.get();
  } catch {
    await config.cloud.p2p.swarm.generate();
  }

  const mainAuth = config.auth.signer["main"];
  await mainAuth.username.set("root");
  await mainAuth.password.set(DROPLET_ROOT_PASSWORD);

  const all = config.shapes.get("all");
  await all
    .services
    .set(["auth", "tns", "hoarder", "seer", "substrate", "patrick", "monkey"]);
  await all.ports.port["main"].set(4242);
  await all.ports.port["lite"].set(4262);

  const hosts = await config.hosts.list();

  const bootstrapers = [];

  for (const droplet of await Droplets()) {
    const { hostname, publicIp, tags } = DropletInfo(droplet);
    if (!hosts.includes(hostname)) {
      const host = config.hosts.get(hostname);
      bootstrapers.push(hostname);

      await host.addresses.add([`${publicIp}/32`]);
      await host.ssh.address.set(`${publicIp}:22`);
      await host.ssh.auth.add(["main"]);
      await host.location.set("40.730610, -73.935242");
      if (!(await host.shapes.list()).includes("all"))
        await host.shapes.get("all").generate();
    }
  }

  await config.cloud.p2p.bootstrap.shape["all"].nodes.add(bootstrapers);

  await config.commit();
};

function extractIpFromCidr(cidr: string): string {
  return cidr.split("/")[0];
}

export const fixDNS = async (config: Config): Promise<boolean> => {
  const apiUser = NAMECHEAP_USERNAME;
  const apiKey = NAMECHEAP_API_KEY;
  const clientIp = NAMECHEAP_IP;
  const domain = DOMAIN;

  if (!apiUser && !apiKey && !clientIp) {
    return false; // skip
  } else if (!apiUser || !apiKey || !clientIp) {
    throw new Error(
      "Environment variables NAMECHEAP_USERNAME, NAMECHEAP_API_KEY, and NAMECHEAP_IP must be set"
    );
  }

  const seerAddrs = [];
  for (const hostname of await config.hosts.list()) {
    if ((await config.hosts.get(hostname).shapes.list()).includes("all")) {
      for (const addr of await config.hosts.get(hostname).addresses.list()) {
        seerAddrs.push(extractIpFromCidr(addr));
      }
    }
  }

  const client = new NamecheapDnsClient(
    apiUser,
    apiKey,
    clientIp,
    domain,
    false
  );

  await client.init();

  client.setAll("seer", "A", seerAddrs);

  client.setAll("tau", "NS", ["seer."+DOMAIN]);

  client.setAll("*.g", "CNAME", ["substrate.tau."+DOMAIN]);

  await client.commit();

  return true;
};

const configPath = `${__dirname}/../config`;

// Ensure config directory exists
if (!existsSync(configPath)) {
  mkdirSync(configPath, { recursive: true });
}

const config: Config = new Config(configPath);

await config.init();

await createConfig(config);

const drive: Drive = new Drive(config, TauLatest);

await drive.init();

const course = await drive.plot(new CourseConfig(["all"]));

console.log("Displacement...");
try {
  await course.displace();
  await displayProgress(course);
  console.log("[Done] Displacement");
} catch {
  process.exit(1);
}

console.log("Update DNS Records...");
try {
  if (await fixDNS(config)) console.log("[Done] DNS Records");
  else console.log("[Skip] DNS Records");
} catch {
  process.exit(2);
}
