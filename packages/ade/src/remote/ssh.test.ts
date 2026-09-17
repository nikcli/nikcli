import { describe, expect, test } from "bun:test"
import { discoverSshHosts, globMatcher, resolveInclude } from "./discover"
import type { Host } from "../host/shell"
import {
  checkRemoteDir,
  isRemoteRoot,
  mergeHosts,
  parseKnownHosts,
  parseRemoteRoot,
  parseSshConfig,
  parseTargetInput,
  remoteName,
  remoteRoot,
  sshArgs,
  sshAsking,
  targetOf,
} from "./ssh"

describe("ssh config", () => {
  test("concrete hosts with their options; patterns and Match blocks are skipped", () => {
    const { hosts, includes } = parseSshConfig(`
# comment
Include config.d/* ~/.ssh/work
Host devbox dev
  HostName 10.0.0.5
  User niko
  Port 2222
Host *.internal !secret
  User nobody
Host=gpu
  Hostname = gpu.example.com
Match host foo
  User ignored
Host "quoted"
`)
    expect(includes).toEqual(["config.d/*", "~/.ssh/work"])
    expect(hosts).toEqual([
      { alias: "devbox", hostName: "10.0.0.5", user: "niko", port: 2222, source: "config" },
      { alias: "dev", hostName: "10.0.0.5", user: "niko", port: 2222, source: "config" },
      { alias: "gpu", hostName: "gpu.example.com", source: "config" },
      { alias: "quoted", source: "config" },
    ])
  })

  test("the first value of an option wins, as in ssh", () => {
    const { hosts } = parseSshConfig("Host a\n  User first\n  User second\n  Port nope\n")
    expect(hosts).toEqual([{ alias: "a", user: "first", source: "config" }])
  })
})

describe("known_hosts", () => {
  test("plain, bracketed with a port, comma lists; hashed and markers handled", () => {
    const hosts = parseKnownHosts(
      [
        "github.com,140.82.121.3 ssh-ed25519 AAAA",
        "[pi.local]:2222 ssh-ed25519 AAAA",
        "|1|abc=|def= ssh-rsa AAAA",
        "@cert-authority *.corp ssh-rsa AAAA",
        "@revoked bad.host ssh-rsa AAAA",
        "github.com ssh-rsa AAAA",
        "",
      ].join("\n"),
    )
    expect(hosts.map((h) => [h.alias, h.port])).toEqual([
      ["github.com", undefined],
      ["140.82.121.3", undefined],
      ["pi.local", 2222],
      ["bad.host", undefined],
    ])
  })

  test("a known host a config entry already reaches is not listed twice", () => {
    const config = parseSshConfig("Host devbox\n  HostName 10.0.0.5\n").hosts
    const known = parseKnownHosts("10.0.0.5 ssh-ed25519 A\nother ssh-ed25519 A\n")
    expect(mergeHosts(config, known).map((h) => h.alias)).toEqual(["devbox", "other"])
  })
})

describe("targets and roots", () => {
  test("what the user types", () => {
    expect(parseTargetInput("devbox")).toEqual({ destination: "devbox" })
    expect(parseTargetInput("niko@10.0.0.5:2222")).toEqual({ destination: "niko@10.0.0.5", port: 2222 })
    expect(parseTargetInput("niko@host:2222/srv/app")).toEqual({
      destination: "niko@host",
      port: 2222,
      dir: "/srv/app",
    })
    expect(parseTargetInput("host:~/app")).toEqual({ destination: "host", dir: "~/app" })
    expect(parseTargetInput("ssh://host/srv")).toEqual({ destination: "host", dir: "/srv" })
    for (const bad of ["", "-oProxyCommand=calc", "host:99999", "host:/it's", "a b", "host:relative/dir"]) {
      expect("error" in parseTargetInput(bad)).toBe(true)
    }
  })

  test("a root round-trips", () => {
    for (const target of [
      { destination: "devbox" },
      { destination: "niko@host", port: 2222, dir: "/srv/app" },
      { destination: "host", dir: "~/app" },
    ]) {
      const root = remoteRoot(target)
      expect(isRemoteRoot(root)).toBe(true)
      expect(parseRemoteRoot(root)).toEqual(target)
    }
    expect(isRemoteRoot("C:/Users/x/repo")).toBe(false)
    expect(parseRemoteRoot("ssh://-oProxyCommand=calc")).toBeUndefined()
  })

  test("a config host keeps its own user and port; a known host carries them", () => {
    expect(targetOf({ alias: "devbox", user: "niko", port: 2222, source: "config" })).toEqual({ destination: "devbox" })
    expect(targetOf({ alias: "pi.local", port: 2222, source: "known_hosts" }, "~/x")).toEqual({
      destination: "pi.local",
      port: 2222,
      dir: "~/x",
    })
  })

  test("names", () => {
    expect(remoteName({ destination: "niko@devbox" })).toBe("devbox · ssh")
    expect(remoteName({ destination: "devbox", dir: "/srv/app" })).toBe("app @ devbox")
  })

  test("folders", () => {
    expect(checkRemoteDir("")).toEqual({})
    expect(checkRemoteDir("~")).toEqual({})
    expect(checkRemoteDir("/srv/app/")).toEqual({ dir: "/srv/app" })
    expect("error" in checkRemoteDir("srv")).toBe(true)
  })
})

describe("the command line", () => {
  test("matches what pty.rs accepts", () => {
    expect(sshArgs({ destination: "devbox" })).toEqual(["-t", "devbox"])
    expect(sshArgs({ destination: "niko@host", port: 2222, dir: "/srv/app" })).toEqual([
      "-t",
      "-p",
      "2222",
      "niko@host",
      `cd -- '/srv/app' && exec "$SHELL" -l`,
    ])
    expect(sshArgs({ destination: "host", dir: "~/app" }).at(-1)).toBe(`cd -- "$HOME"/'app' && exec "$SHELL" -l`)
  })

  test("a password or fingerprint question is not a prompt to type into", () => {
    expect(sshAsking("niko@host's password:")).toBe(true)
    expect(sshAsking("Enter passphrase for key '/home/n/.ssh/id_ed25519':")).toBe(true)
    expect(sshAsking("Are you sure you want to continue connecting (yes/no/[fingerprint])?")).toBe(true)
    expect(sshAsking("niko@devbox:~/app$")).toBe(false)
  })
})

describe("discovery", () => {
  test("include paths resolve the way ssh resolves them", () => {
    expect(resolveInclude("config.d/*", "C:\\Users\\n")).toBe("C:\\Users\\n\\.ssh\\config.d/*")
    expect(resolveInclude("~/work", "/home/n")).toBe("/home/n/work")
    expect(resolveInclude("/etc/ssh/x", "/home/n")).toBe("/etc/ssh/x")
    expect(globMatcher("*.conf")("work.conf")).toBe(true)
    expect(globMatcher("*.conf")("work.conf.bak")).toBe(false)
  })

  test("reads the config, its includes and known_hosts", async () => {
    const files: Record<string, string> = {
      "/home/n/.ssh/config": "Include conf.d/*\nHost devbox\n  HostName 10.0.0.5\n",
      "/home/n/.ssh/conf.d/work": "Host gpu\n",
      "/home/n/.ssh/known_hosts": "10.0.0.5 ssh-ed25519 A\npi.local ssh-ed25519 A\n",
    }
    const host = {
      probe: async () => "/usr/bin/ssh",
      homeDir: async () => "/home/n",
      readTextFile: async (path: string) => {
        if (!(path in files)) throw new Error("missing")
        return { text: files[path]!, truncated: false, bytes: files[path]!.length }
      },
      readDir: async (dir: string) =>
        dir === "/home/n/.ssh/conf.d"
          ? [{ name: "work", path: "/home/n/.ssh/conf.d/work", is_dir: false, size: 1, modified_ms: 0 }]
          : [],
    } as unknown as Host
    const found = await discoverSshHosts(host)
    expect(found.client).toBe("/usr/bin/ssh")
    expect(found.hosts.map((h) => h.alias)).toEqual(["devbox", "gpu", "pi.local"])
  })
})
