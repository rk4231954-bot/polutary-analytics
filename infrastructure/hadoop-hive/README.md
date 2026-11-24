# infrastructure/hadoop-hive

Docker Compose setup for a real, single-node Hadoop (HDFS NameNode + DataNode) and Apache Hive (Metastore + HiveServer2) cluster for local development.

**Status: not yet implemented (stage 7).** This directory has no `docker-compose.yml` on purpose. The compose file is written and tested against a running Docker engine in stage 7.

Planned services and ports:

| Service       | Purpose                              | Port  |
|---------------|--------------------------------------|-------|
| namenode      | HDFS NameNode + WebHDFS              | 9870  |
| datanode      | HDFS DataNode                        | 9864  |
| metastore     | Hive Metastore (persistent backend)  | 9083  |
| hiveserver2   | HiveServer2 (Thrift, used by PyHive) | 10000 |

Prerequisite: Docker Engine with Compose v2. On WSL2, turn on Docker Desktop's WSL integration for this distro, or install Docker Engine inside WSL.

## Running the native (WSL) Hadoop + Hive install

Until the Compose file exists, development runs against a native single-node install:

- Hadoop 3.4.2 in `$HADOOP_HOME` and Hive 4.1.0 in `$HIVE_HOME`, on Java 17.
- MapReduce in `local` mode (no YARN) and an embedded Derby metastore.
- Hive data lives in the `poultry_analytics` database:
  - `poultry_records`: empty and unused (see `docs/research/datasets.md`);
  - `poultry_records_staging`: over `/poultry-analytics/raw`;
  - `poultry_records_cleaned`: the table the API reads.

### Configuration this setup depends on

Back up `conf/` / `etc/hadoop/` before changing any of these.

| File | Setting | Why |
|---|---|---|
| `$HIVE_HOME/conf/hive-env.sh` | `export HADOOP_HEAPSIZE=2048` | Local-mode MR tasks run inside the HiveServer2 JVM. With 256 MB, GROUP BY failed with `OutOfMemoryError` ("return code 2"). |
| `hive-site.xml` | `javax.jdo.option.ConnectionURL` with an **absolute** Derby path | A relative path creates a new, empty metastore wherever Hive starts ("Table not found"). |
| `hive-site.xml` | `hive.exec.submit.local.task.via.child=false` | Map-join local tasks failed in a child JVM ("return code 1" on JOIN). |
| `hive-site.xml` | `hive.server2.authentication=CUSTOM` and the `polutary.hs2.auth.file` path | HiveServer2 requires a user name and password (see Security). |
| `hive-site.xml` | `hive.server2.thrift.bind.host` / `hive.server2.webui.host` = `127.0.0.1` | HiveServer2 (10000) and its web UI (10002) accept local connections only. |
| `core-site.xml` | `hadoop.proxyuser.kiran.hosts=127.0.0.1,localhost` and `hadoop.proxyuser.kiran.users=kiran` | Only the HiveServer2 account may impersonate, only locally, and only as itself. |
| `hdfs-site.xml` | NameNode, SecondaryNameNode and DataNode addresses on `127.0.0.1` (9870, 9868, 9864, 9866, 9867) | WebHDFS/DataNode ports aren't reachable from other machines (see Security). |

### Security

**Authentication (HiveServer2)**
- HiveServer2 runs as the OS user `kiran`.
- Every connection must sign in. `org.polutary.hive.auth.FileAuthenticationProvider` checks
  the user name and password against PBKDF2-HMAC-SHA256 hashes (600 000 iterations) in
  `~/.config/polutary-analytics/hs2-users`.
  - Source code and build script: [`hs2-auth/`](hs2-auth/). The jar goes into `$HIVE_HOME/auxlib`.
  - The file must be mode 0600; otherwise every login is refused.
  - It's read on each login, so password changes apply without a restart.
- Connections without credentials, as `anonymous`, with a wrong password or with an unknown
  user are refused. Refusals are logged without the password.

**Authorisation (Hive and HDFS)**
- Queries run as the signed-in user (`doAs`), so HDFS permissions decide what each Hive user
  can read or write.
- The `poultry_analytics` warehouse directories belong to `kiran`, mode 755.
- Impersonation is limited to `kiran` acting as `kiran` from localhost. The earlier
  `hadoop.proxyuser.anonymous.* = *` rules, which let an unauthenticated client impersonate any
  user, are gone.

**Permissions (least privilege)**

| HDFS path | Before | Now | Why |
|---|---|---|---|
| `/tmp` | `777` | `1777` | Sticky bit: users can't delete each other's temp files. |
| `/user/hive/warehouse` | `777` | `755` | Only the owner (`kiran`) creates databases/tables. |
| `/user/hive/warehouse/poultry_analytics.db/**` | owner `anonymous` | owner `kiran` | No longer writable by the unauthenticated account. |
| `/tmp/hive` | `733` | `733` (unchanged) | HiveServer2 refuses to start unless its scratch root is at least 733. Each user's own scratch directory below it is 700. |

No local (Linux) directory used by Hadoop or Hive is world-writable.

**Remaining limit: Hadoop "simple" authentication.** HDFS has no Kerberos here. A local
process can still claim to be `kiran` to the NameNode or WebHDFS (`?user.name=kiran`). That's
why every HDFS port is bound to 127.0.0.1. Removing this last gap means Kerberos, which is out
of scope for this single-machine project.

**Managing HiveServer2 users**

```bash
# add a user or change a password (prompts twice; the file is rewritten with mode 0600)
python3 infrastructure/hadoop-hive/hs2-auth/hs2_passwd.py ~/.config/polutary-analytics/hs2-users kiran
# the API's credentials: HIVE_USERNAME / HIVE_PASSWORD / HIVE_AUTH=CUSTOM in apps/api/.env (mode 0600)
# after editing FileAuthenticationProvider.java:
HIVE_HOME=~/apache-hive-4.1.0-bin HADOOP_HOME=~/hadoop infrastructure/hadoop-hive/hs2-auth/build.sh
# then restart HiveServer2
```

### Start-up

Start the services in this order. Each step has a check; don't continue until it passes.

```bash
# 1. HDFS (NameNode, DataNode, SecondaryNameNode)
start-dfs.sh
until hdfs dfsadmin -safemode get | grep -q OFF; do sleep 2; done
hdfs dfs -ls /poultry-analytics/raw          # poultry_records.csv is listed

# 2. HiveServer2. First check that it isn't already running: two instances on one
#    embedded Derby metastore lock each other out.
pgrep -f '[D]proc_hiveserver2' && echo "already running"
cd "$HIVE_HOME" && nohup hive --service hiveserver2 > ~/hiveserver2.out 2>&1 &
until ss -ltn | grep -q '127.0.0.1\]*:10000 '; do sleep 5; done   # takes 30-90 s

# 3. Beeline. Sign in with your HiveServer2 password. A bare -p as the LAST option
#    prompts for it, which keeps it out of the shell history. (-w FILE reads it from a
#    0600 file instead.)
beeline -u jdbc:hive2://localhost:10000/poultry_analytics -n kiran \
  -e "SHOW TABLES; SELECT farm_id, COUNT(*) FROM poultry_records_cleaned GROUP BY farm_id;" -p

# 4. Flask API (+ Vite frontend). Reads HIVE_* from apps/api/.env.
cd ~/Developer/polutary-analytics && bun run dev     # or: cd apps/api && uv run python run.py
curl -s http://127.0.0.1:5000/api/health
# Signed in as admin/analyst/farm manager, GET /api/analytics/status lists the Hive tables.
```

### Shutdown

Stop the services in the reverse order. Each step is a graceful stop, and no data is removed.

```bash
# 1. Flask API / Vite: Ctrl+C in the terminal running `bun run dev` (or `uv run python run.py`)

# 2. HiveServer2: SIGTERM lets it close the Derby metastore cleanly
kill -TERM "$(pgrep -f '[D]proc_hiveserver2')"
while pgrep -f '[D]proc_hiveserver2' >/dev/null; do sleep 1; done

# 3. HDFS
stop-dfs.sh
```

Don't use `kill -9` on HiveServer2 or delete Derby's `*.lck` files. Derby clears stale locks
when it next starts.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| API returns 503 `HIVE_UNAVAILABLE` | HiveServer2 isn't running or not listening yet. Run start-up step 2. |
| API returns 503 `HIVE_AUTH_FAILED` | `HIVE_USERNAME` / `HIVE_PASSWORD` in `apps/api/.env` don't match the credentials file, or `HIVE_AUTH` isn't `CUSTOM`. Reset with `hs2_passwd.py`. |
| Beeline: `Error validating the login` | Wrong or missing user name or password (`-n kiran … -p`). |
| Every login refused; HS2 log says "must be readable by its owner only" | `chmod 600 ~/.config/polutary-analytics/hs2-users` |
| `return code 2` on GROUP BY | HiveServer2 heap too small; check `hive-env.sh`. |
