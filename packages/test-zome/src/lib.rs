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

/// Validation callback (required)
#[hdk_extern]
fn validate(_op: Op) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}
