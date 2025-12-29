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

/// Test get_details host function
/// Retrieves full details including validation status
#[hdk_extern]
fn get_details_test(hash: ActionHash) -> ExternResult<Option<Details>> {
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

/// Validation callback (required)
#[hdk_extern]
fn validate(_op: Op) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}
