package org.polutary.hive.auth;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.PosixFilePermission;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import javax.security.sasl.AuthenticationException;
import org.apache.hadoop.hive.conf.HiveConf;
import org.apache.hive.service.auth.PasswdAuthenticationProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * HiveServer2 password check (hive.server2.authentication=CUSTOM) against a local
 * credentials file, for a single-node install without LDAP or Kerberos.
 *
 * <p>The file is named by the HiveServer2 property {@code polutary.hs2.auth.file}. Each
 * non-comment line is {@code user:pbkdf2-sha256:iterations:saltBase64:hashBase64}; write it
 * with hs2_passwd.py. The file is read on every login, so password changes apply without a
 * restart, and it must be readable by its owner only (mode 0600) or every login is refused.
 * Passwords are never logged.
 */
public final class FileAuthenticationProvider implements PasswdAuthenticationProvider {

  public static final String FILE_PROPERTY = "polutary.hs2.auth.file";
  private static final String SCHEME = "pbkdf2-sha256";
  private static final Logger LOG = LoggerFactory.getLogger(FileAuthenticationProvider.class);
  private static final Set<PosixFilePermission> NOT_ALLOWED =
      Set.of(
          PosixFilePermission.GROUP_READ,
          PosixFilePermission.GROUP_WRITE,
          PosixFilePermission.OTHERS_READ,
          PosixFilePermission.OTHERS_WRITE);
  // Used for unknown users so that the response time does not reveal which users exist.
  private static final byte[] DUMMY_SALT = new byte[16];

  private final Path file;

  public FileAuthenticationProvider(HiveConf conf) {
    String location = conf.get(FILE_PROPERTY);
    if (location == null || location.isBlank()) {
      throw new IllegalStateException(FILE_PROPERTY + " is not set in hive-site.xml");
    }
    this.file = Paths.get(location);
  }

  @Override
  public void authenticate(String user, String password) throws AuthenticationException {
    if (user == null || user.isEmpty() || password == null || password.isEmpty()) {
      throw new AuthenticationException("A user name and password are required");
    }
    String[] entry = find(user);
    boolean ok;
    if (entry == null) {
      hash(password, DUMMY_SALT, 600_000);
      ok = false;
    } else {
      byte[] expected = Base64.getDecoder().decode(entry[4]);
      byte[] actual =
          hash(password, Base64.getDecoder().decode(entry[3]), Integer.parseInt(entry[2]));
      ok = MessageDigest.isEqual(expected, actual);
    }
    if (!ok) {
      LOG.warn("HiveServer2 login refused for user '{}'", user);
      throw new AuthenticationException("Invalid user name or password");
    }
  }

  private String[] find(String user) throws AuthenticationException {
    List<String> lines;
    try {
      Set<PosixFilePermission> mode = Files.getPosixFilePermissions(file);
      if (mode.stream().anyMatch(NOT_ALLOWED::contains)) {
        LOG.error("{} must be readable by its owner only (chmod 600); refusing logins", file);
        throw new AuthenticationException("Authentication is misconfigured");
      }
      lines = Files.readAllLines(file, StandardCharsets.UTF_8);
    } catch (IOException e) {
      LOG.error("Cannot read the HiveServer2 credentials file {}", file, e);
      throw new AuthenticationException("Authentication is misconfigured", e);
    }
    for (String line : lines) {
      String trimmed = line.trim();
      if (trimmed.isEmpty() || trimmed.startsWith("#")) {
        continue;
      }
      String[] parts = trimmed.split(":");
      if (parts.length == 5 && parts[0].equals(user) && parts[1].equals(SCHEME)) {
        return parts;
      }
    }
    return null;
  }

  private static byte[] hash(String password, byte[] salt, int iterations)
      throws AuthenticationException {
    try {
      PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, iterations, 256);
      try {
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
      } finally {
        spec.clearPassword();
      }
    } catch (GeneralSecurityException e) {
      throw new AuthenticationException("Password hashing failed", e);
    }
  }
}
