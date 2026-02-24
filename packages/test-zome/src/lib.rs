use hdk::prelude::*;

/// Test entry type for create/get operations
#[hdk_entry_helper]
#[derive(Clone)]
pub struct TestEntry {
    pub content: String,
    pub timestamp: Timestamp,
}

#[hdk_extern]
fn init(_: ()) -> ExternResult<InitCallbackResult> {
    Ok(InitCallbackResult::Pass)
}

/// Test agent_info host function
/// Returns agent public key and chain head info
#[hdk_extern]
fn get_agent_info(_: ()) -> ExternResult<AgentInfo> {
    agent_info()
}

/// Test zome_info host function
/// Returns zome metadata including entry defs and zome types
#[hdk_extern]
fn get_zome_info(_: ()) -> ExternResult<ZomeInfo> {
    zome_info()
}

/// Test entry_defs callback directly
#[hdk_extern]
fn get_entry_defs_test(_: ()) -> ExternResult<EntryDefsCallbackResult> {
    entry_defs(())
}

/// Test random_bytes host function
/// Returns 32 random bytes
#[hdk_extern]
fn get_random_bytes(_: ()) -> ExternResult<Vec<u8>> {
    let bytes = random_bytes(32)?;
    Ok(bytes.to_vec())
}

/// Test sys_time host function
/// Returns current system timestamp
#[hdk_extern]
fn get_timestamp(_: ()) -> ExternResult<Timestamp> {
    sys_time()
}

/// Test trace host function
/// Logs a message to the console
#[hdk_extern]
fn trace_message(msg: String) -> ExternResult<()> {
    trace!(msg);
    Ok(())
}

/// Test sign_ephemeral and verify_signature host functions
/// Generates ephemeral keypair, signs data, and verifies
#[hdk_extern]
fn test_signing(_: ()) -> ExternResult<bool> {
    // Test data to sign
    let data = b"Hello, Holochain!";

    // Sign with ephemeral key
    let EphemeralSignatures { key, signatures } = sign_ephemeral(vec![data.to_vec()])?;

    // Get the first signature
    let signature = signatures.get(0).ok_or(wasm_error!(WasmErrorInner::Guest(
        "No signature returned".to_string()
    )))?;

    // Verify the signature
    let valid = verify_signature(key, signature.clone(), data.to_vec())?;

    Ok(valid)
}

/// Test create host function
/// Creates a test entry and returns the action hash
#[hdk_extern]
fn create_test_entry(content: String) -> ExternResult<ActionHash> {
    let entry = TestEntry {
        content,
        timestamp: sys_time()?,
    };

    create_entry(&EntryTypes::TestEntry(entry))
}

/// Test get host function
/// Retrieves a record by action hash
#[hdk_extern]
fn get_test_entry(hash: ActionHash) -> ExternResult<Option<Record>> {
    get(hash, GetOptions::default())
}

/// Test get_details host function with ActionHash
/// Retrieves full details including validation status
#[hdk_extern]
fn get_details_test(hash: ActionHash) -> ExternResult<Option<Details>> {
    get_details(hash, GetOptions::default())
}

/// Test get_details host function with EntryHash
/// Retrieves entry details when querying by entry hash
#[hdk_extern]
fn get_details_by_entry_hash(hash: EntryHash) -> ExternResult<Option<Details>> {
    get_details(hash, GetOptions::default())
}

/// Input for update_test_entry
#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct UpdateEntryInput {
    pub original_hash: ActionHash,
    pub new_content: String,
}

/// Test update host function
/// Updates an existing entry and returns the new action hash
#[hdk_extern]
fn update_test_entry(input: UpdateEntryInput) -> ExternResult<ActionHash> {
    let new_entry = TestEntry {
        content: input.new_content,
        timestamp: sys_time()?,
    };

    update_entry(input.original_hash, &EntryTypes::TestEntry(new_entry))
}

/// Test delete host function
/// Deletes an entry by creating a delete action
#[hdk_extern]
fn delete_test_entry(hash: ActionHash) -> ExternResult<ActionHash> {
    delete_entry(hash)
}

/// Test emit_signal host function
/// Emits a signal with the provided message
#[hdk_extern]
fn emit_signal_test(message: String) -> ExternResult<()> {
    emit_signal(&message)?;
    Ok(())
}

/// Test query host function
/// Queries the local source chain for all TestEntry records
#[hdk_extern]
fn query_test(_: ()) -> ExternResult<Vec<Record>> {
    let filter = ChainQueryFilter::new();
    query(filter)
}

/// Input for create_test_link
#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct CreateLinkInput {
    pub base: ActionHash,
    pub target: ActionHash,
}

/// Test create_link host function
/// Creates a link from one action hash to another
#[hdk_extern]
fn create_test_link(input: CreateLinkInput) -> ExternResult<ActionHash> {
    create_link(input.base, input.target, LinkTypes::Placeholder, ())
}

/// Test get_links host function
/// Gets all links from a base
#[hdk_extern]
fn get_test_links(base: ActionHash) -> ExternResult<Vec<Link>> {
    let query = LinkQuery::try_new(base, LinkTypes::Placeholder)?;
    get_links(query, GetStrategy::default())
}

/// Test delete_link host function
/// Deletes a link by its create action hash
#[hdk_extern]
fn delete_test_link(link_add_hash: ActionHash) -> ExternResult<ActionHash> {
    delete_link(link_add_hash, GetOptions::default())
}

/// Test count_links host function
/// Counts links from a base
#[hdk_extern]
fn count_test_links(base: ActionHash) -> ExternResult<usize> {
    let query = LinkQuery::try_new(base, LinkTypes::Placeholder)?;
    count_links(query)
}

/// Test atomic operations: create entry + link in single zome call
/// If link creation fails, entry should not be persisted
/// Returns: (entry_action_hash, link_action_hash)
#[hdk_extern]
fn create_entry_with_link(target_hash: ActionHash) -> ExternResult<(ActionHash, ActionHash)> {
    // Create entry
    let entry = TestEntry {
        content: "Entry with link".to_string(),
        timestamp: sys_time()?,
    };

    let entry_hash = create_entry(&EntryTypes::TestEntry(entry))?;

    // Create link to target
    let link_hash = create_link(
        entry_hash.clone(),
        target_hash,
        LinkTypes::Placeholder,
        (),
    )?;

    Ok((entry_hash, link_hash))
}

/// Test function that INTENTIONALLY fails after creating entry
/// Used to test rollback behavior
#[hdk_extern]
fn create_entry_then_fail(_: ()) -> ExternResult<ActionHash> {
    // Create entry
    let entry = TestEntry {
        content: "This should roll back".to_string(),
        timestamp: sys_time()?,
    };

    let _entry_hash = create_entry(&EntryTypes::TestEntry(entry))?;

    // Intentionally fail
    Err(wasm_error!(WasmErrorInner::Guest(
        "Intentional failure for rollback test".to_string()
    )))
}

/// Entry types enum (required by HDK)
#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    #[entry_type(required_validations = 5)]
    TestEntry(TestEntry),
}

/// Link types enum (required even if not using links)
#[hdk_link_types]
pub enum LinkTypes {
    #[allow(dead_code)]
    Placeholder,
}

/// Genesis self-check callback
///
/// Validates agent membership before genesis records are created.
/// Logic:
/// - If DNA properties have no "progenitor" key -> open membrane, return Valid
/// - If "progenitor" key exists -> require a membrane proof that is the
///   progenitor's Ed25519 signature over the joining agent's public key bytes.
///
/// The membrane proof bytes are the raw 64-byte Ed25519 signature produced by
/// the progenitor signing the new agent's AgentPubKey (39 bytes).
///
/// Properties format (msgpack-encoded object):
/// { "progenitor": [u8; 39] }  -- AgentPubKey of the progenitor node
#[hdk_extern]
fn genesis_self_check(data: GenesisSelfCheckData) -> ExternResult<ValidateCallbackResult> {
    let dna_info = dna_info()?;

    // Deserialize DNA properties from SerializedBytes (msgpack) into a JSON map.
    // SerializedBytes -> UnsafeBytes -> Vec<u8> -> rmp_serde::from_slice
    // The TS side encodes properties as msgpack of a JS object, so array values
    // (e.g. Uint8Array stored as number[]) come through as serde_json arrays of integers.
    let props_bytes: Vec<u8> = UnsafeBytes::from(dna_info.modifiers.properties).into();
    let props: std::collections::HashMap<String, serde_json::Value> =
        rmp_serde::from_slice(&props_bytes).unwrap_or_default();

    // Open membrane: no progenitor configured
    if !props.contains_key("progenitor") {
        return Ok(ValidateCallbackResult::Valid);
    }

    // Closed membrane: progenitor exists, membrane proof is required
    let proof = match data.membrane_proof {
        Some(p) => p,
        None => {
            return Ok(ValidateCallbackResult::Invalid(
                "Membrane proof required but not provided".to_string(),
            ))
        }
    };

    // Extract progenitor AgentPubKey bytes from properties.
    // Stored as array of u8 integers: [132, 32, 36, ...]
    let progenitor_bytes: Vec<u8> = match props.get("progenitor") {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_u64().map(|n| n as u8))
            .collect(),
        _ => {
            return Ok(ValidateCallbackResult::Invalid(
                "Progenitor key in DNA properties is not a valid byte array".to_string(),
            ))
        }
    };

    // Build AgentPubKey from the 39 raw bytes (3 prefix + 32 core + 4 DHT location)
    let progenitor_key = AgentPubKey::try_from_raw_39(progenitor_bytes).map_err(|e| {
        wasm_error!(WasmErrorInner::Guest(format!(
            "Invalid progenitor key bytes: {:?}",
            e
        )))
    })?;

    // Extract the 64-byte signature from MembraneProof (Arc<SerializedBytes>).
    // MembraneProof = Arc<SerializedBytes>. The raw bytes inside are msgpack-encoded.
    // SerializedBytes -> UnsafeBytes -> Vec<u8> gives the raw msgpack.
    // Then rmp_serde::from_slice deserializes the msgpack bin format back to Vec<u8>.
    let proof_raw: Vec<u8> = UnsafeBytes::from(proof.as_ref().clone()).into();
    let proof_bytes: Vec<u8> = rmp_serde::from_slice(&proof_raw).map_err(|e| {
        wasm_error!(WasmErrorInner::Guest(format!(
            "Failed to deserialize membrane proof: {:?}",
            e
        )))
    })?;

    if proof_bytes.len() != 64 {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "Membrane proof must be 64 bytes (Ed25519 signature), got {}",
            proof_bytes.len()
        )));
    }

    // Build Signature from the 64 proof bytes
    let mut sig_bytes = [0u8; 64];
    sig_bytes.copy_from_slice(&proof_bytes);
    let signature = Signature(sig_bytes);

    // The signed data is the raw bytes of the joining agent's AgentPubKey (39 bytes).
    // Use verify_signature_raw so the bytes are not re-serialized.
    let agent_key_bytes: Vec<u8> = data.agent_key.get_raw_39().to_vec();

    let valid = verify_signature_raw(progenitor_key, signature, agent_key_bytes)?;

    if valid {
        Ok(ValidateCallbackResult::Valid)
    } else {
        Ok(ValidateCallbackResult::Invalid(
            "Membrane proof signature verification failed".to_string(),
        ))
    }
}

/// Validation callback (required)
#[hdk_extern]
fn validate(_op: Op) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}
