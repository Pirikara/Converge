import { describe, it, expect } from "vitest";
import { parsePom, editPomVersion } from "../src/adapters/maven/pom.js";
import { parseGradle, editGradleVersion } from "../src/adapters/maven/gradle.js";
import { parseVersionCatalog, editVersionCatalog } from "../src/adapters/maven/catalog.js";
import { isStable, compareMaven, maxStableMaven, maxStableMavenFor, flavor, mavenUpdateType } from "../src/adapters/maven/versioning.js";
import { splitCoordinate } from "../src/adapters/maven/central.js";
import { isMavenManifest } from "../src/adapters/maven/index.js";

const POM = `<project>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>2.15.0</version>
    </dependency>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-core</artifactId>
      <version>\${spring.version}</version>
    </dependency>
    <dependency>
      <groupId>org.projectlombok</groupId>
      <artifactId>lombok</artifactId>
    </dependency>
  </dependencies>
</project>`;

describe("parsePom / editPomVersion", () => {
  it("reads literal-version deps, skips property refs and managed deps", () => {
    const deps = parsePom(POM);
    expect(deps).toEqual([
      { name: "com.fasterxml.jackson.core:jackson-databind", range: "2.15.0", kind: "prod" },
    ]);
  });
  it("rewrites the targeted version only", () => {
    const out = editPomVersion(POM, "com.fasterxml.jackson.core:jackson-databind", "2.15.0", "2.18.0");
    expect(out).toContain("<version>2.18.0</version>");
    expect(out).toContain("${spring.version}"); // untouched
  });
  it("throws when absent", () => {
    expect(() => editPomVersion(POM, "x:y", "1.0", "2.0")).toThrow();
  });

  it("ignores commented-out dependencies (no false positives)", () => {
    const pom = `<project><dependencies>
      <!-- <dependency><groupId>evil</groupId><artifactId>x</artifactId><version>1.0</version></dependency> -->
      <dependency><groupId>g</groupId><artifactId>a</artifactId><version>1.2.3</version></dependency>
    </dependencies></project>`;
    expect(parsePom(pom).map((d) => d.name)).toEqual(["g:a"]);
    // edit offsets stay valid despite the (masked) comment, which is preserved.
    const out = editPomVersion(pom, "g:a", "1.2.3", "2.0.0");
    expect(out).toContain("<version>2.0.0</version>");
    expect(out).toContain("<groupId>evil</groupId>"); // comment untouched
  });

  it("does not parse plugin versions as dependencies", () => {
    const pom = `<project><build><plugins><plugin>
      <groupId>org.apache.maven.plugins</groupId>
      <artifactId>maven-surefire-plugin</artifactId>
      <version>3.1.2</version>
    </plugin></plugins></build></project>`;
    expect(parsePom(pom)).toEqual([]);
  });
});

const GRADLE = `dependencies {
  implementation 'com.google.guava:guava:32.0.0-jre'
  api("org.jetbrains.kotlin:kotlin-stdlib:1.9.0")
  testImplementation "org.junit.jupiter:junit-jupiter:5.9.0"
  implementation "com.example:dynamic:1.+"
}`;

describe("parseGradle / editGradleVersion", () => {
  it("parses quoted coordinates (Groovy + Kotlin), skips dynamic versions", () => {
    const map = Object.fromEntries(parseGradle(GRADLE).map((d) => [d.name, d.range]));
    expect(map["com.google.guava:guava"]).toBe("32.0.0-jre");
    expect(map["org.jetbrains.kotlin:kotlin-stdlib"]).toBe("1.9.0");
    expect(map["org.junit.jupiter:junit-jupiter"]).toBe("5.9.0");
    expect(map["com.example:dynamic"]).toBeUndefined();
  });
  it("rewrites a coordinate version", () => {
    const out = editGradleVersion(GRADLE, "com.google.guava:guava", "32.0.0-jre", "33.0.0-jre");
    expect(out).toContain("com.google.guava:guava:33.0.0-jre");
    expect(out).toContain("kotlin-stdlib:1.9.0"); // untouched
  });

  it("handles a coordinate with a classifier, preserving it on edit", () => {
    const g = `dependencies { testImplementation "org.apache.kafka:kafka-clients:3.5.0:test" }`;
    expect(parseGradle(g)).toEqual([{ name: "org.apache.kafka:kafka-clients", range: "3.5.0", kind: "prod" }]);
    expect(editGradleVersion(g, "org.apache.kafka:kafka-clients", "3.5.0", "3.6.0")).toContain(
      "org.apache.kafka:kafka-clients:3.6.0:test",
    );
  });

  it("does not treat plugin id/version as a coordinate", () => {
    const g = `plugins { id "org.springframework.boot" version "3.1.0" }`;
    expect(parseGradle(g)).toEqual([]);
  });
});

const CATALOG = `[versions]
junit = "5.9.0"
guava = "32.0.0-jre"

[libraries]
junit-api = { module = "org.junit.jupiter:junit-jupiter-api", version.ref = "junit" }
guava = { module = "com.google.guava:guava", version.ref = "guava" }
gson = { module = "com.google.code.gson:gson", version = "2.10" }
okhttp = "com.squareup.okhttp3:okhttp:4.11.0"
`;

describe("parseVersionCatalog / editVersionCatalog", () => {
  it("resolves version.ref, inline, and shorthand-string forms", () => {
    const map = Object.fromEntries(parseVersionCatalog(CATALOG).map((d) => [d.name, d.range]));
    expect(map["org.junit.jupiter:junit-jupiter-api"]).toBe("5.9.0"); // via ref
    expect(map["com.google.code.gson:gson"]).toBe("2.10"); // inline
    expect(map["com.squareup.okhttp3:okhttp"]).toBe("4.11.0"); // shorthand string
  });
  it("edits the [versions] entry for a ref", () => {
    const out = editVersionCatalog(CATALOG, "org.junit.jupiter:junit-jupiter-api", "5.9.0", "5.10.2");
    expect(out).toContain('junit = "5.10.2"');
    expect(out).toContain('guava = "32.0.0-jre"'); // other version untouched
  });
  it("edits an inline version and a shorthand string", () => {
    expect(editVersionCatalog(CATALOG, "com.google.code.gson:gson", "2.10", "2.11")).toContain('version = "2.11"');
    expect(editVersionCatalog(CATALOG, "com.squareup.okhttp3:okhttp", "4.11.0", "4.12.0")).toContain("okhttp:4.12.0");
  });

  it("ignores the [plugins] section, reading only [libraries]", () => {
    const cat = `[versions]
k = "1.9.0"
[plugins]
kotlin = { id = "org.jetbrains.kotlin.jvm", version.ref = "k" }
[libraries]
core = { module = "g:a", version.ref = "k" }`;
    expect(parseVersionCatalog(cat)).toEqual([{ name: "g:a", range: "1.9.0", kind: "prod" }]);
  });
});

describe("maven versioning", () => {
  it("flags pre-release qualifiers", () => {
    expect(isStable("2.15.0")).toBe(true);
    expect(isStable("2.15.0.RELEASE")).toBe(true);
    expect(isStable("2.16.0-rc1")).toBe(false);
    expect(isStable("3.0.0-M2")).toBe(false);
    expect(isStable("1.0.0-alpha")).toBe(false);
    expect(isStable("1.0-SNAPSHOT")).toBe(false);
  });
  it("compares by numeric release tuple", () => {
    expect(compareMaven("2.18.0", "2.15.0") > 0).toBe(true);
    expect(compareMaven("2.15.0.RELEASE", "2.15.0") === 0).toBe(true);
    expect(maxStableMaven(["2.15.0", "2.18.0", "3.0.0-rc1", "2.16.1"])).toBe("2.18.0");
  });
  it("classifies the delta", () => {
    expect(mavenUpdateType("2.15.0", "3.0.0")).toBe("major");
    expect(mavenUpdateType("2.15.0", "2.16.0")).toBe("minor");
    expect(mavenUpdateType("2.15.0", "2.15.1")).toBe("patch");
  });
  it("keeps an update on the same release line (Guava jre/android)", () => {
    expect(flavor("32.0.0-jre")).toBe("jre");
    expect(flavor("2.15.0.RELEASE")).toBe("");
    const guava = ["31.1-jre", "32.0.0-jre", "33.6.0-jre", "32.0.0-android", "33.6.0-android"];
    expect(maxStableMavenFor("32.0.0-jre", guava)).toBe("33.6.0-jre");
    expect(maxStableMavenFor("32.0.0-android", guava)).toBe("33.6.0-android");
  });
});

describe("splitCoordinate / isMavenManifest", () => {
  it("splits group:artifact", () => {
    expect(splitCoordinate("com.google.guava:guava")).toEqual({ group: "com.google.guava", artifact: "guava" });
    expect(splitCoordinate("nogroup")).toBeNull();
  });
  it("matches manifests outside build dirs", () => {
    expect(isMavenManifest("pom.xml")).toBe(true);
    expect(isMavenManifest("app/build.gradle.kts")).toBe(true);
    expect(isMavenManifest("gradle/libs.versions.toml")).toBe(true);
    expect(isMavenManifest("target/classes/pom.xml")).toBe(false);
    expect(isMavenManifest("build/build.gradle")).toBe(false);
  });
});
