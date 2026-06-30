import { describe, it, expect } from "vitest";
import { parseTerraform, editTerraformVersion } from "../src/adapters/terraform/hcl.js";
import {
  tfConstraintToRange,
  bumpConstraint,
  currentSatisfied,
  latestStable,
  tfUpdateType,
} from "../src/adapters/terraform/versioning.js";
import { isTerraformManifest } from "../src/adapters/terraform/index.js";

const TF = `
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    google = {
      version = "= 4.50.0"
      source  = "hashicorp/google"
    }
    # a local-only provider with no registry source shape
    custom = {
      source = "localhost/custom"
    }
  }
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.1.2"
}

module "local" {
  source = "./modules/thing"
}

module "git" {
  source = "git::https://example.com/vpc.git"
}
`;

describe("parseTerraform", () => {
  it("extracts registry providers (source+version), order-independent", () => {
    const deps = parseTerraform(TF);
    const map = Object.fromEntries(deps.map((d) => [d.name, d.range]));
    expect(map["hashicorp/aws"]).toBe("~> 5.0");
    expect(map["hashicorp/google"]).toBe("= 4.50.0"); // version listed before source
  });

  it("parses inline single-line provider blocks (both fields after commas)", () => {
    const tf = `terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
}`;
    expect(parseTerraform(tf)).toEqual([
      { name: "hashicorp/google", range: "~> 5.0", kind: "prod" },
    ]);
  });

  it("ignores commented-out provider blocks, keeps the real one", () => {
    const tf = `terraform {
  required_providers {
    # aws = { source = "hashicorp/aws", version = "~> 4.0" }
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
}`;
    const deps = parseTerraform(tf);
    expect(deps.map((d) => d.name)).toEqual(["hashicorp/google"]);
    // the commented "~> 4.0" must not be the edit target
    const out = editTerraformVersion(tf, "hashicorp/google", "~> 5.0", "~> 6.0");
    expect(out).toContain('version = "~> 6.0"');
    expect(out).toContain('# aws = { source = "hashicorp/aws", version = "~> 4.0" }');
  });

  it("extracts registry modules and skips local/git/no-version sources", () => {
    const deps = parseTerraform(TF);
    const names = deps.map((d) => d.name);
    expect(names).toContain("terraform-aws-modules/vpc/aws");
    expect(names).not.toContain("localhost/custom"); // 2-seg but custom host w/o version
    expect(names.some((n) => n.includes("modules/thing"))).toBe(false);
    expect(names.some((n) => n.includes("example.com"))).toBe(false);
  });
});

describe("editTerraformVersion", () => {
  it("rewrites the constraint for the matching provider only", () => {
    const out = editTerraformVersion(TF, "hashicorp/aws", "~> 5.0", "~> 6.0");
    expect(out).toContain('version = "~> 6.0"');
    expect(out).toContain('version = "= 4.50.0"'); // google untouched
    expect(out).toContain('version = "5.1.2"'); // module untouched
  });

  it("rewrites a module constraint", () => {
    const out = editTerraformVersion(TF, "terraform-aws-modules/vpc/aws", "5.1.2", "5.5.0");
    expect(out).toContain('version = "5.5.0"');
    expect(out).toContain('version = "~> 5.0"'); // aws provider untouched
  });

  it("throws when the source/version pair is absent", () => {
    expect(() => editTerraformVersion(TF, "hashicorp/aws", "~> 9.9", "~> 10")).toThrow();
  });
});

describe("tfConstraintToRange", () => {
  it("maps pessimistic and comparison operators to npm ranges", () => {
    expect(tfConstraintToRange("~> 5.0")).toBe("^5.0.0");
    expect(tfConstraintToRange("~> 5.1.0")).toBe("~5.1.0");
    expect(tfConstraintToRange("= 4.50.0")).toBe("=4.50.0");
    expect(tfConstraintToRange(">= 4.0, < 5.0")).toBe(">=4.0 <5.0");
    expect(tfConstraintToRange("!= 5.0.0")).toBeNull();
  });
});

describe("currentSatisfied / latestStable", () => {
  const versions = ["4.50.0", "5.0.0", "5.31.0", "6.0.0", "6.4.2", "7.0.0-beta1"];
  it("finds the max satisfying a constraint", () => {
    expect(currentSatisfied("~> 5.0", versions)).toBe("5.31.0");
    expect(currentSatisfied("= 4.50.0", versions)).toBe("4.50.0");
  });
  it("ignores prereleases for latest", () => {
    expect(latestStable(versions)).toBe("6.4.2");
  });
});

describe("bumpConstraint", () => {
  it("preserves operator and granularity", () => {
    expect(bumpConstraint("~> 5.0", "6.4.2")).toBe("~> 6.0");
    expect(bumpConstraint("~> 5.1.0", "6.4.2")).toBe("~> 6.4.0");
    expect(bumpConstraint("5.1.2", "5.5.0")).toBe("5.5.0");
    expect(bumpConstraint("= 4.50.0", "4.60.0")).toBe("= 4.60.0");
  });
  it("declines open-ended ranges it won't rewrite", () => {
    expect(bumpConstraint(">= 4.0", "6.0.0")).toBeNull();
    expect(bumpConstraint(">= 4.0, < 5.0", "6.0.0")).toBeNull();
  });
});

describe("tfUpdateType", () => {
  it("classifies the delta", () => {
    expect(tfUpdateType("5.31.0", "6.4.2")).toBe("major");
    expect(tfUpdateType("5.1.0", "5.2.0")).toBe("minor");
    expect(tfUpdateType("5.1.0", "5.1.1")).toBe("patch");
  });
});

describe("isTerraformManifest", () => {
  it("matches .tf files outside the .terraform cache", () => {
    expect(isTerraformManifest("main.tf")).toBe(true);
    expect(isTerraformManifest("infra/modules/vpc/versions.tf")).toBe(true);
    expect(isTerraformManifest(".terraform/modules/x/main.tf")).toBe(false);
    expect(isTerraformManifest("main.tf.json")).toBe(false);
    expect(isTerraformManifest("README.md")).toBe(false);
  });
});
