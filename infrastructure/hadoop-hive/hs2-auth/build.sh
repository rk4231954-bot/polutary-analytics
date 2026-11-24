#!/usr/bin/env bash
# Compiles FileAuthenticationProvider against the installed Hive/Hadoop jars and installs
# the jar into $HIVE_HOME/auxlib (bin/hive adds that folder to HiveServer2's classpath).
# Restart HiveServer2 afterwards.
set -euo pipefail

: "${HIVE_HOME:?set HIVE_HOME}"
: "${HADOOP_HOME:?set HADOOP_HOME}"
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

cp="$(ls "$HIVE_HOME"/lib/hive-service-[0-9]*.jar "$HIVE_HOME"/lib/hive-common-[0-9]*.jar \
  "$HADOOP_HOME"/share/hadoop/common/hadoop-common-[0-9]*[0-9].jar \
  "$HADOOP_HOME"/share/hadoop/common/lib/slf4j-api-*.jar | tr '\n' ':')"

javac --release 17 -Xlint:all,-classfile -Werror -cp "$cp" -d "$out/classes" \
  "$here"/src/org/polutary/hive/auth/FileAuthenticationProvider.java
mkdir -p "$HIVE_HOME/auxlib"
jar --create --file "$HIVE_HOME/auxlib/polutary-hs2-auth.jar" -C "$out/classes" .
echo "Installed $HIVE_HOME/auxlib/polutary-hs2-auth.jar"
