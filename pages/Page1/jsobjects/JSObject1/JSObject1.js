export default {
	update_status_change_reason_selector: (status) => {
		if (status.toLowerCase() == 'active' || status.toLowerCase() == 'a') {
			storeValue("status_change_reasons", constants.status_change_reason_activate)
		} else {
			storeValue("status_change_reasons", constants.status_change_reason_inactivate)
		}

	},
	merge_patient: async (kept_patient_id, kept_member_id, merged_id, id_type) => {
		try {
			const member_id = kept_member_id;
			let merge_log = {};

			// only allow if member id active at paysign
			let kept_card_status;
			try {
				await paysign_get_card_details.run({ member_id: member_id });
				kept_card_status = paysign_get_card_details?.data?.card_status;
			} catch (err) {
				console.log(err);
				console.log(err.toString());
				showAlert("Failed to get primary patient Paysign card");
				throw new Error("Failed to get primary patient Paysign card");
			}
			if (kept_card_status !== "Active") {
				showAlert("Primary patient Card Status at Paysign is: " + kept_card_status + ". Can only merge to Active member");
				return;
			}

			// get merged patient
			let merged_patient;
			let merged_patient_id;
			let merged_member_id;

			if (id_type == "patient_id") {
				merged_patient_id = parseInt(merged_id);
				merged_patient = await get_patient_by_patient_id.run({ patient_id: merged_id });
			} else if (id_type == "member_id") {
				merged_patient = await get_patient_by_member_id.run({ member_id: merged_id });
				merged_patient_id = parseInt(merged_patient?.patient_id);
			}

			const merged_enrollment_status = merged_patient?.enrollment_status;
			merged_member_id = merged_patient?.member_id;

			if (!merged_enrollment_status || !merged_patient_id || !merged_member_id) {
				showAlert("Patient to be merged not found.");
				return;
			}

			// get kept patient
			const kept_patient = await get_patient_by_patient_id.run({ patient_id: kept_patient_id });
			const kept_patient_enrollment_data = JSON.parse(kept_patient?.enrollment_data || "{}");
			const merged_patient_enrollment_data = JSON.parse(merged_patient?.enrollment_data || "{}");

			// check that a merged patient is not being merged into kept patient more than once
			if (
				(merged_patient_enrollment_data.merged_to_patient_id !== null && merged_patient_enrollment_data.merged_to_patient_id !== undefined) ||
				(merged_patient_enrollment_data.merged_to_member_id !== null && merged_patient_enrollment_data.merged_to_member_id !== undefined) ||
				kept_patient_enrollment_data?.merged_patient_id?.includes(merged_patient_id) ||
				kept_patient_enrollment_data?.merged_patient_id?.includes(merged_member_id)
			) {
				showAlert("Cannot merge a patient into another patient more than once at this time");
				return;
			}
			// check that a previous kept patient is not being merged back into its previous merged patient
			else if (
				kept_patient_enrollment_data.merged_to_patient_id === merged_patient_id ||
				kept_patient_enrollment_data.merged_to_member_id === merged_member_id ||
				merged_patient_enrollment_data?.merged_patient_id?.includes(kept_patient_id) ||
				merged_patient_enrollment_data?.merged_member_id?.includes(kept_member_id)
			) {
				showAlert("Cannot merge a patient back into an account that was previously merged to it");
				return;
			}

			// get kept patient and merged patient database drug balances
			const kept_patient_benefit_amounts = JSON.parse(kept_patient?.benefits_amounts || "{}");
			const merged_patient_benefit_amounts = JSON.parse(merged_patient?.benefits_amounts || "{}");
			const kept_patient_drug_balance = parseInt(utils.get_paysign_formatted_number(kept_patient_benefit_amounts?.current_period?.balance_amount_drug, true));
			const merged_patient_drug_balance = parseInt(
				utils.get_paysign_formatted_number(merged_patient_benefit_amounts?.current_period?.balance_amount_drug, true)
			);

			if (isNaN(kept_patient_drug_balance)) {
				throw new Error("Unable to get primary patient database balance");
			} else if (isNaN(merged_patient_drug_balance)) {
				throw new Error("Unable to get secondary patient database balance");
			}

			// get kept patient paysign balance
			let kept_patient_ps_available_balance;
			let kept_patient_ps_available_balance_api_response;

			try {
				kept_patient_ps_available_balance_api_response = await xr_ps_get_avlbl_balance_api.run({ member_id: member_id });
				kept_patient_ps_available_balance = parseInt(kept_patient_ps_available_balance_api_response?.balance);
			} catch (err) {
				console.log(err);
				console.log(err.toString());

				kept_patient_ps_available_balance_api_response = xr_ps_get_avlbl_balance_api?.data;

				if (
					kept_patient_ps_available_balance_api_response?.message === "Error updating balance. The limit record does not exist." &&
					kept_patient_ps_available_balance_api_response?.response_code === 400
				) {
					// manually set kept_patient_ps_available_balance to 1500000 since api gives 400 when balance has never been touched
					kept_patient_ps_available_balance = 1500000;
				}
			}

			if (isNaN(kept_patient_ps_available_balance)) {
				throw new Error("Unable to get primary card paysign balance");
			}

			merge_log["kept_patient_paysign_balance_response"] = kept_patient_ps_available_balance_api_response;

			// get merged patient paysign balance
			let merged_patient_paysign_available_balance;
			let merged_patient_ps_available_balance_api_response;

			try {
				merged_patient_ps_available_balance_api_response = await xr_ps_get_avlbl_balance_api.run({ member_id: merged_member_id });
				merged_patient_paysign_available_balance = parseInt(merged_patient_ps_available_balance_api_response?.balance);
			} catch (err) {
				console.log(err);
				console.log(err.toString());

				merged_patient_ps_available_balance_api_response = xr_ps_get_avlbl_balance_api?.data;

				if (
					merged_patient_ps_available_balance_api_response?.message === "Error updating balance. The limit record does not exist." &&
					merged_patient_ps_available_balance_api_response?.response_code === 400
				) {
					// manually set merged_patient_paysign_available_balance to 1500000 since api gives 400 when balance has never been touched
					merged_patient_paysign_available_balance = 1500000;
				} else {
					// check card status to see if its unloaded
					let merged_card_status;
					let paysign_get_card_details_response;

					try {
						paysign_get_card_details_response = await paysign_get_card_details.run({ member_id: merged_member_id });
						merged_card_status = paysign_get_card_details_response?.card_status;
					} catch (err) {
						console.log(err);
						console.log(err.toString());

						paysign_get_card_details_response = paysign_get_card_details?.data;
					}

					merge_log["paysign_get_card_details_response"] = paysign_get_card_details_response;

					// manually set merged_patient_paysign_available_balance to 1500000 since the card is unloaded and the balance has never been touched
					if (merged_card_status === "Unloaded") {
						merged_patient_paysign_available_balance = 1500000;
					}

					// manually set merged_patient_paysign_available_balance to merged_patient_drug_balance if the member id is a
					// duplicate id based on the paysign api responses and the id having a "-" in it
					else if (
						merged_patient_ps_available_balance_api_response?.message === "Invalid data.  No matching records on file." &&
						merged_patient_ps_available_balance_api_response?.response_code === 400 &&
						paysign_get_card_details_response?.message === "no member number found" &&
						paysign_get_card_details_response?.response_code === 404 &&
						merged_member_id?.toString()?.includes("-")
					) {
						merged_patient_paysign_available_balance = merged_patient_drug_balance;
					}
				}
			}

			if (isNaN(merged_patient_paysign_available_balance)) {
				throw new Error("Unable to get secondary card paysign balance");
			}

			merge_log["merged_patient_paysign_balance_response"] = merged_patient_ps_available_balance_api_response;

			// ensure database balance amounts match current paysign balances
			// - needed because pbm claims can be processed and PS card updated, but balance change not reflected yet in db
			//   since we receive file a day late
			if (kept_patient_drug_balance !== kept_patient_ps_available_balance) {
				throw new Error("Primary patient database and paysign balance do not match, please escalate to IT");
			} else if (merged_patient_drug_balance !== merged_patient_paysign_available_balance) {
				throw new Error("Secondary patient database and paysign balance do not match, please escalate to IT");
			}

			// add data to merge_log
			merge_log["kept_patient"] = kept_patient;
			merge_log["merged_patient"] = merged_patient;
			merge_log["kept_patient_drug_balance"] = kept_patient_drug_balance;
			merge_log["kept_patient_ps_available_balance"] = kept_patient_ps_available_balance;
			merge_log["merged_patient_drug_balance"] = merged_patient_drug_balance;
			merge_log["merged_patient_paysign_available_balance"] = merged_patient_paysign_available_balance;

			// merge patients
			try {
				showAlert("Processing merge of patient " + merged_member_id.toString() + " to " + member_id.toString());

				// call merge patient store procedure
				await merge_patient_sp.run({ kept_patient_id: kept_patient_id, merged_patient_id: merged_patient_id });
				const merge_result = JSON.parse(JSON.stringify(merge_patient_sp.data?.[0] || {}));
				merge_log["merge_result"] = merge_result;

				// set merged patient as inactive
				let merged_patient_ps_inactivation_response;

				try {
					merged_patient_ps_inactivation_response = await update_card_status_api.run({ member_id: merged_member_id, card_status: "I" });
					merge_log["update_merged_card_status_api"] = "Member Inactivated at PS " + merged_member_id;
					showAlert(`Merged card ${merged_member_id} successfully inactivated`);
				} catch (err) {
					console.log(err);
					console.log(err.toString());

					merged_patient_ps_inactivation_response = update_card_status_api?.data;
					merge_log["update_merged_card_status_api"] = "Error Inactivating Member at PS " + merged_member_id;
					showAlert(`Merged card ${merged_member_id} possibly NOT inactivated - Please escalate to IT`);

					// Inactivating an already inactive card causes an error, this could be used to check against that but deciding to leave out for now
					// if (
					//     merged_patient_ps_inactivation_response?.message === "Unable to process request." &&
					//     merged_patient_ps_inactivation_response?.response_code === 422
					// ) {
					//     merge_log["update_merged_card_status_api"] = "Member Inactivated at PS " + merged_member_id;
					//     showAlert(`Merged card ${merged_member_id} successfully inactivated`);
					// } else {
					//     merge_log["update_merged_card_status_api"] = "Error Inactivating Member at PS " + merged_member_id;
					//     showAlert(`Merged card ${merged_member_id} NOT inactivated - Please escalate to IT`);
					// }
				}

				merge_log["merged_patient_ps_inactivation_response"] = merged_patient_ps_inactivation_response;

				// update paysign balance based on new merged drug balance
				if (merge_result?.status === "success") {
					const new_benefits_amounts = JSON.parse(merge_result?.new_benefits_amounts || "{}");
					let new_used_amount_drug = new_benefits_amounts?.current_period?.used_amount_drug;
					merge_log["new_used_amount_drug"] = new_used_amount_drug;

					if (new_used_amount_drug === null || new_used_amount_drug === undefined) {
						throw new Error("Unable to get new used amount drug");
					}

					if (new_used_amount_drug > 0) {
						// get other payment accum for accum_amt_submitted_for_update calculation
						let other_payment_accum;
						let other_payment_accum_response;

						try {
							other_payment_accum_response = await xr_ps_get_other_payment_api.run({ member_id: member_id });
							other_payment_accum = parseInt(other_payment_accum_response?.balance);
						} catch (err) {
							console.log(err);
							console.log(err.toString());

							other_payment_accum_response = xr_ps_get_other_payment_api?.data;

							if (
								other_payment_accum_response?.message === "Error updating balance. The limit record does not exist." &&
								other_payment_accum_response?.response_code === 400
							) {
								// manually set other_payment_accum to 0 since api gives 400 when balance has never been touched
								other_payment_accum = 0;
							}
						}

						merge_log["other_payment_accum_response"] = other_payment_accum_response;
						if (isNaN(other_payment_accum)) {
							throw new Error("Unable to get other payment accumulated amount");
						}
						merge_log["other_payment_accum"] = other_payment_accum;

						// get rx payment accum for accum_amt_submitted_for_update calculation
						let rx_payment_accum;
						let rx_payment_accum_response;

						try {
							rx_payment_accum_response = await xr_ps_get_rx_payment_api.run({ member_id: member_id });
							rx_payment_accum = parseInt(rx_payment_accum_response?.balance);
						} catch (err) {
							console.log(err);
							console.log(err.toString());

							rx_payment_accum_response = xr_ps_get_rx_payment_api?.data;

							if (
								rx_payment_accum_response?.message === "Error updating balance. The limit record does not exist." &&
								rx_payment_accum_response?.response_code === 400
							) {
								// manually set rx_payment_accum to 0 since api gives 400 when balance has never been touched
								rx_payment_accum = 0;
							}
						}

						merge_log["rx_payment_accum_response"] = rx_payment_accum_response;
						if (isNaN(rx_payment_accum)) {
							throw new Error("Unable to get Rx payment accumulated amount");
						}
						merge_log["rx_payment_accum"] = rx_payment_accum;

						const rx_payment_offset = rx_payment_accum - other_payment_accum;
						if (rx_payment_offset < 0) {
							throw new Error("Rx payment offset < 0, cannot update paysign card balance");
						} else if (rx_payment_offset % 1 !== 0) {
							throw new Error("Rx payment offset in not an int, cannot update paysign card balance");
						}

						// update at paysign
						let update_accumulator_ps_response;

						try {
							let accum_amt_submitted_for_update = utils.get_paysign_formatted_number(new_used_amount_drug, true);
							accum_amt_submitted_for_update = parseInt(accum_amt_submitted_for_update) - rx_payment_offset;

							merge_log["accum_amt_submitted_for_update"] = accum_amt_submitted_for_update;

							if (isNaN(accum_amt_submitted_for_update)) {
								throw new Error("Accumulate update amount is NaN");
							} else if (accum_amt_submitted_for_update < 0) {
								throw new Error("Total accumulated amount for update < 0");
							}

							accum_amt_submitted_for_update = utils.get_paysign_formatted_number(accum_amt_submitted_for_update, false);
							update_accumulator_ps_response = await update_accumulator_ps.run({ balance: accum_amt_submitted_for_update, member_id: member_id });

							merge_log["update_accumulator_ps"] = update_accumulator_ps_response;
						} catch (err) {
							console.log(err);
							console.log(err.toString());

							update_accumulator_ps_response = update_accumulator_ps?.data;
							merge_log["update_accumulator_ps"] = update_accumulator_ps_response;

							showAlert("Error updating paysign balance. Please escalate to IT.");
							throw new Error(err?.message?.toString() || "Failed to update Paysign balance");
						}
					} else if (new_used_amount_drug < 0) {
						throw new Error("New used amount drug < 0");
					} else if (new_used_amount_drug === 0) {
						merge_log["update_accumulator_ps"] = "New used amount drug = 0, balance update not required";
					} else {
						throw new Error(`Unexpected behavior with new used amount drug ${new_used_amount_drug}`);
					}

					showAlert("Patient merge successful.");
				} else {
					showAlert("Merge procedure failed");
				}
			} catch (err) {
				console.log(err);
				console.log(err.toString());
				showAlert("Error encountered attempting to merge patients. Return message: " + err?.message?.toString());
				merge_log["error_message"] = err?.message?.toString();
				throw new Error(err);
			} finally {
				console.log(merge_log);
				await log.run({
					action_type: constants.merge_patient,
					ref_id: member_id,
					ref_id_type: constants.member_id,
					change_json: JSON.stringify(merge_log),
				});
			}
		} catch (err) {
			console.log(err);
			console.log(err.toString());
			showAlert(`Failing with error: ${err?.message?.toString() || "Unable to merge"}`);
			showAlert("Error with merge, please escalate to IT");
		}
	},
	get_date_enrollment_change_to_inactive: async (member_id) => {

		await get_date_enrollment_inactive.run({member_id: member_id})	
		// showAlert("found " + get_date_enrollment_inactive.data.length)
		if (get_date_enrollment_inactive.data.length == 0) {
			if (patient_lookup_table.triggeredRow["Enrollment Status"] == "Active" || patient_lookup_table.triggeredRow["Enrollment Status"] == "active") {
				storeValue("enrollment_end_dt", "")				
			} else {
				storeValue("enrollment_end_dt", "Enrollment End Date Not Available")
			}
			return
		}
		const res = get_date_enrollment_inactive.data[0]
		let date_made_inactive = res["created"]
		if (date_made_inactive){		
			date_made_inactive = new Date(date_made_inactive)
		}

		const res_json = JSON.parse(JSON.stringify(res))
		const change_json =  res_json.change_json //res["change_json"]["patient_id"]

		const jsonified_change_json = JSON.parse(JSON.stringify(change_json))

		// var patient = jsonified_change_json.patient

		var patient 
		JSON.parse(jsonified_change_json, (key, value) => key === 'patient' ? (patient = value) : value)


		const stringified_patient = JSON.stringify(patient)

		const jsonified_patient = JSON.parse(stringified_patient)

		// var enrollment_status
		// JSON.parse(stringified_patient, (key, value) => key === 'enrollment_status' ? (enrollment_status = value) : value)		


		if (jsonified_patient.enrollment_status == 'Inactive' || jsonified_patient.enrollment_status == 'inactive') {
			const converted_date = this.convertDOB(date_made_inactive)
			if (get_date_enrollment_inactive.data.length == 0) {
				storeValue("enrollment_end_dt", "Enrollment End Date Not Available")
			} else {
				storeValue("enrollment_end_dt", converted_date)						
			}
		} else {
			storeValue("enrollment_end_dt", "")
		}
	},		
	register_pending_patient: async (patient_obj, make_card_match_enrollment_status) => {
		const first_name = patient_obj["First Name"];
		const last_name = patient_obj["Last Name"];
		const gender = patient_obj["Gender"]?.charAt(0).toUpperCase() == "M" ? "MALE" : patient_obj["Gender"]?.charAt(0).toUpperCase() == "F" ? "FEMALE" : "OTHER";
		let dob = this.convertDOB(patient_obj["Date of Birth"])
		let dob_split = dob.split('-');
		const date_of_birth = `${dob_split[1]}/${dob_split[2]}/${dob_split[0]}`;
		const member_id = patient_obj["Member ID"];
		let paysign_patient_registration_api_response
		const paysign_patient_registration_api_request = {first_name: first_name, last_name: last_name, gender: gender, date_of_birth: date_of_birth, member_id: member_id}
		try {
			paysign_patient_registration_api_response = await paysign_patient_registration.run(paysign_patient_registration_api_request);
			if (paysign_patient_registration_api_response.message === "Form Successfully Submitted.") {
				showAlert("Patient registration successful. " + paysign_patient_registration_api_response.message);
			}
			else {
				showAlert("Error while registering patient. " + paysign_patient_registration_api_response.message + " - Please escalate to IT");
			}
		} catch (e) {
			paysign_patient_registration_api_response = paysign_patient_registration.data

			if (paysign_patient_registration_api_response.message === "Member ID already used.") {
				showAlert("Patient already registered");
			}
			else {
				showAlert("Error while registering patient. " + paysign_patient_registration_api_response.message + " - Please escalate to IT");
			}
		} finally {
			await log.run({action_type: constants.patient_card_registration, ref_id: member_id, ref_id_type: constants.member_id, change_json: JSON.stringify({request: paysign_patient_registration_api_request, response: paysign_patient_registration_api_response}) });						
		}

		if (make_card_match_enrollment_status) {
			const enrollment_status = patient_obj?.["Enrollment Status"]?.toString().toLowerCase();
			if (enrollment_status == "inactive" || enrollment_status == "pending") {
				const new_status = "I";

				const update_card_status_api_request = {member_id: member_id, card_status: new_status}
				let update_card_status_api_response 

				try {
					update_card_status_api_response = await update_card_status_api.run(update_card_status_api_request);
					showAlert("Card Status Successfully Set to Inactive to Match Patient's Enrollment Status");
				} catch (err) {
					update_card_status_api_response = update_card_status_api.data
					showAlert("Error updating patient card status to Inactive to match patient's enrollment status - Please escalate to IT");
				} finally {
					await log.run({action_type: constants.update_paysign_card_status_inactive, ref_id: member_id, ref_id_type: constants.member_id, change_json: JSON.stringify({request: update_card_status_api_request, response: update_card_status_api_response}) });
				}
			} 
		}
	},
	reset_patient_pw_after_validation: async (member_id, new_password_hash, patient_id) => {
		try {
			if (!this.is_valid_patient_credentials(member_id, new_password_hash)) {
				return;
			}

			showAlert(`Resetting password for member ${member_id} to ${new_password_hash}`);

			const patient_password_reset_api_request = {
				patient_id: patient_id,
				member_id: member_id,
				new_password_hash: new_password_hash,
			};
			let patient_password_reset_api_response;
			try {
				patient_password_reset_api_response = await patient_password_reset_api.run(patient_password_reset_api_request);
			} catch (err) {
				patient_password_reset_api_response = patient_password_reset_api?.data;
				throw new Error("Failed to reset patient password");
			} finally {
				await log.run({
					action_type: constants.patient_pw_reset,
					ref_id: member_id,
					ref_id_type: constants.member_id,
					change_json: JSON.stringify({request: patient_password_reset_api_request, response: patient_password_reset_api_response}),
				});
				showAlert(patient_password_reset_api_response?.result ? `Password successfully reset to ${new_password_hash}` : "Password reset failed");
			}
		} catch (err) {
			console.log(err);
			showAlert("Password reset failed");
		}
	},
	reset_patient_password: async (member_id, new_password_hash, patient_id, enrollment_status) => {
		try {
			// see if user login is valid using current member id
			const validate_user_res = await validate_user_api.run({ login_id: member_id });

			if (validate_user_res?.message?.toString().trim().toLowerCase() === "login found") {
				// reset pw since user validated
				this.reset_patient_pw_after_validation(member_id, new_password_hash, patient_id);
			} else {
				// user login not found, create user login
				const user_type = "patient";
				// call api to create login
				showAlert(`Resetting password for member ${member_id} to ${new_password_hash}`);

				const add_user_api_request = { login_id: member_id, password_hash: new_password_hash, user_type: user_type, xref_id: patient_id };
				let add_user_api_response;
				try {
					add_user_api_response = await add_user_api.run({ add_user_api_request: add_user_api_request });
				} catch (err) {
					add_user_api_response = add_user_api?.data;
					throw new Error("Failed to reset patient password");
				} finally {
					await log.run({
						action_type: constants.add_patient_user,
						ref_id: member_id,
						ref_id_type: constants.member_id,
						change_json: JSON.stringify({ request: add_user_api_request, response: add_user_api_response }),
					});
					showAlert(
						add_user_api_response?.message === "User created" ? `Password successfully reset to ${new_password_hash}` : "Password reset failed"
					);
				}

				const update_patient_request = {
					patient_id: patient_id,
					member_id: member_id,
					enrollment_status: enrollment_status,
					credentials_id: member_id,
				};
				let update_patient_api_response;
				try {
					update_patient_api_response = await patient_update_background_api.run({
						update_payload: update_patient_request,
					});
				} catch (err) {
					update_patient_api_response = patient_update_background_api?.data;
				} finally {
					await log.run({
						action_type: constants.update_patient_user,
						ref_id: member_id,
						ref_id_type: constants.member_id,
						change_json: JSON.stringify({ request: update_patient_request, response: update_patient_api_response }),
					});

					if (update_patient_api_response?.message === "Patient updated") {
						showAlert("Patient record updated successfully, refreshing page view")
						await patient_helper_obj.patient_lookup(patient_lookup_txt.text, patient_lookup_list.selectedOptionValue, "", "")
					}
					else {
						showAlert(`Failed to fully update record for member_id: ${member_id} - Please escalate to IT`);
					}
				}
			}
		} catch (e) {
			showAlert("Error encountered " + e.message);
		}
	},
	is_valid_patient_credentials: (member_id, new_password_hash) => {
		if (member_id === "") {
			showAlert("Cannot reset password for this patient, missing Member ID")
			return false
		} else if (!new_password_hash.match(/^[A-Z]{2}\d{5}$/)) {
			showAlert("Cannot reset password for this patient, missing First Name, Last Name, or Zipcode")
			return false
		}

		return true
	},
	confirm_and_update_enrollment_status: async (confirm_text, new_enrollment_status, enrollment_status_reason) => {
		// update card enrollment status in db and card status at paysign after confirmation 
		if (confirm_text === 'confirm') {

			try {
				// update database enrollment status automatically
				// await this.update_enrollment_status(patient_lookup_table.selectedRow["Database ID"], patient_lookup_table.selectedRow["Member ID"], new_enrollment_status);
				let enrollment_end_date = new Date().getFullYear() + "-12-31"
				if (new_enrollment_status == 'Inactive' || new_enrollment_status == 'inactive') {
					enrollment_end_date = (new Date()).toISOString().split('T')[0]
				} else {

				}
				await this.update_enrollment_data_db(patient_lookup_table.selectedRow["Database ID"], new_enrollment_status, enrollment_status_reason, enrollment_end_date)
				showAlert("Enrollment Status Change Successfuly Set to: " + new_enrollment_status);

				// get card status 
				await paysign_get_card_details.run({member_id: patient_lookup_table.selectedRow["Member ID"]});
				const card_detail = paysign_get_card_details.data;
				const card_status = card_detail?.card_status || ""; 

				// check if card status needs to be updated and update accordingly --> paysin "A" is Active and "I" is Inactive
				let new_status; 
				if (new_enrollment_status == "Active") {
					new_status = "A";
					// if previous status was pending, register patient in paysign by submitting patient info to associate with member id 
					// before submitting patient info, do a call to api to get card status so don't have to register patient if card status is already active 
					if (card_status == "Active") {
						showAlert("Patient card status is already Active.")
					} else 
						if (card_status == "Inactive") {
							// change to active status
							await update_card_status_api.run({member_id: patient_lookup_table.selectedRow["Member ID"], card_status: new_status});
							showAlert("Card Status Successfully Set to: " + new_enrollment_status);		
							await log.run({action_type: constants.update_paysign_card_status_active, ref_id: patient_lookup_table.selectedRow["Member ID"], ref_id_type: constants.member_id, change_json: JSON.stringify(update_card_status_api.data) });		

						} else {
							// register pending  patient to pair patient info to card # (if card not active or inactive, must be pending)
							this.register_pending_patient( patient_lookup_table.selectedRow );
						}

				} else if (new_enrollment_status == "Inactive") {
					new_status = "I";

					if (card_status == "Active") {
						// change to Inactive status
						await update_card_status_api.run({member_id: patient_lookup_table.selectedRow["Member ID"], card_status: new_status});
						showAlert("Card Status Successfully Set to: " + patient_status_sel.selectedOptionLabel);		
						await log.run({action_type: constants.update_patient_enrollment_status, ref_id: patient_lookup_table.selectedRow["Member ID"], ref_id_type: constants.member_id, change_json: JSON.stringify(update_card_status_api.data) });								
					} else if (card_status == "Inactive") {
						showAlert("Patient card status is already Inactive.")
					} else {
						// No need to register card if making inactive
					} 
				} else if (new_enrollment_status == "Pending") {
					new_status = "I";					
					if (card_status == "Active") {
						// change to Inactive status
						await update_card_status_api.run({member_id: patient_lookup_table.selectedRow["Member ID"], card_status: new_status});
						showAlert("Card Status Successfully Set to: " + new_enrollment_status);									 
						await log.run({action_type: constants.update_paysign_card_status_inactive, ref_id: patient_lookup_table.selectedRow["Member ID"], ref_id_type: constants.member_id, change_json: JSON.stringify(update_card_status_api.data) });		
					} else if (card_status == "Inactive") {
						showAlert("Patient card status is already Inactive.")
					} else {
						// No need to register card if set Pending
					}
				}
			} catch(e) {
				showAlert("Card Update Failed " + e.message + " - Please escalate to IT");
			}
			finally {
				await patient_helper_obj.patient_lookup(patient_lookup_txt.text, patient_lookup_list.selectedOptionValue, "", "")
				closeModal('mdlConfirmUpdateEnrlStatus');
			}
		} else {
			showAlert("Please type 'confirm' and Press Update to Change Enrollment Status")
		}
	},
	update_patient_enrollment_status: async (patient_id, drug_patient, drug_admin_patient, enrollment_status) => {
		// use this to update enrollment status that includes drug and drug amin Y/N but just need to update logic to include those fields
		// currently not implemented - but when implementing remember to add logs
		if (!patient_id) {
			showAlert("Please Close this Modal and Make Sure to Highlight Patient in Lookup Table");
			return;
		}

		if (!drug_patient || !drug_admin_patient || !enrollment_status) {
			showAlert("Drug Patient, Drug-Admin Patient, and Enrollment Status Cannot be Blank.");
			return;
		}
		try {
			await patient_status_update_api.run({patient_id: patient_id, drug_patient: drug_patient, drug_admin_patient: drug_admin_patient, enrollment_status: enrollment_status});
			showAlert("Patient Status Update Api Complete " + patient_status_update_api.data);
			await log.run({action_type: constants.update_patient_enrollment_status, ref_id: patient_id, ref_id_type: constants.patient_id, change_json: JSON.stringify(patient_status_update_api.data) });		

		} catch (e) {
			showAlert("Error calling patient status update api " + e.message);
		}

	},
	update_enrollment_data_db: async (patient_id, enrollment_status, enrollment_status_reason, enrollment_end_date) => {

		// use this to update enrollment status only - leaving drug and drug admin as is
		if (!patient_id) {
			showAlert("Patient must be Selected in Lookup Table");
			return;
		}
		if (!enrollment_status) {
			showAlert("Please Select an Enrollment Status");
			return;
		}
		try {
			await update_enrollment_data.run({patient_id: patient_id, enrollment_status: enrollment_status,enrollment_status_reason: enrollment_status_reason, enrollment_end_date: enrollment_end_date})

			showAlert("Enrollment Status Update Successful \n" + update_enrollment_data.data)
			await log.run({action_type: constants.update_patient_enrollment_status, ref_id: patient_id, ref_id_type: constants.patient_id, change_json: JSON.stringify(update_enrollment_data.data) })			
		} catch(e) {
			showAlert("Enrollment Status Update Failed " + e.message);
		}
	},	
	update_patient_status_select: (admin_status, drug_admin_status)	=> {
		// Use this to update enrollment status and drug and drug-admin status
		// showAlert(admin_status.trim().toUpperCase())
		// showAlert(drug_admin_status.trim().toUpperCase())
		if ("N" == admin_status.trim().toUpperCase() && "N" == drug_admin_status.trim().toUpperCase()) {
			showAlert("Updating will change enrollment status to inactive");
			storeValue("enrollment_status", "Inactive");
		} else {
			showAlert("Updating will change enrollment status to active")
			storeValue("enrollment_status", "Active");
		}
	},		
	put_parsed_patient_data_into_store: (patient_obj) => {

		storeValue('patient_provider_data', patient_obj.patient_provider_data);
		storeValue('provider_data', patient_obj.provider_data);
		storeValue('enrollment_data', patient_obj.patient_enrollment);
		storeValue('commercial_insurance', patient_obj.commercial_insurance);
		storeValue('patient_benefits_amounts', patient_obj.patient_benefits_amounts);
		storeValue('card_data', patient_obj.card_data);

		storeValue("patient_lap", patient_obj.patient_lap);

		storeValue('verification_data', patient_obj.verification_data);


		// storeValue("patient_enrollment", patient_lookup_table.selectedRow["patient_enrollment"]);
		// storeValue("patient_lap", patient_lookup_table.selectedRow["patient_lap"]);				
		// storeValue("patient_provider_data", patient_lookup_table.selectedRow["patient_provider_data"]);
		// storeValue("patient_commercial_insurance", patient_lookup_table.selectedRow["patient_commercial_insurance"]);
		// storeValue("patient_benefits_amounts", patient_lookup_table.selectedRow["patient_benefits_amounts"]);			
		// storeValue("card_data", patient_lookup_table.selectedRow["card_data"]);

		// storeValue("provider_data", patient_lookup_table.selectedRow.provider_data || "")
		// 
		// storeValue("enrollment_status", patient_lookup_table.selectedRow["Enrollment Status"])
	},
	map_patient: (patients) => {
		const indication_mapping = {
			"moderate-to-severe-persistent-asthma-in-patients-6-years-of-age-and-older-whose-asthma-symptoms-are-not-well-controlled-with-asthma-medicines-called-inhaled-corticosteroids.-a-skin-or-blood-test-is-performed-to-see-if-you-have-allergies-to-year-round-allergens.-it-is-not-known-if-xolair-is-safe-and-effective-in-people-with-asthma-under-6-years-of-age.":
			"Moderate to severe persistent asthma in people 6 years of age and older whose asthma symptoms are not well controlled with asthma medicines called inhaled corticosteroids. A skin or blood test is performed to see if you have allergies to year-round allergens. It is not known if XOLAIR is safe and effective in people with asthma under 6 years of age.",
			1: "Moderate to severe persistent asthma in people 6 years of age and older whose asthma symptoms are not well controlled with asthma medicines called inhaled corticosteroids. A skin or blood test is performed to see if you have allergies to year-round allergens. It is not known if XOLAIR is safe and effective in people with asthma under 6 years of age.",
			"chronic-spontaneous-urticaria-(csu,-previously-referred-to-as-chronic-idiopathic-urticaria-(ciu),-chronic-hives-without-a-known-cause)-in-people-12-years-of-age-and-older-who-continue-to-have-hives-that-are-not-controlled-with-h1-antihistamine-treatment.--it-is-not-known-if-xolair-is-safe-and-effective-in-people-with-csu-under-12-years-of-age.":
			"Chronic spontaneous urticaria (CSU, previously referred to as chronic idiopathic urticaria (CIU), chronic hives without a known cause) in people 12 years of age and older who continue to have hives that are not controlled with H1 antihistainine treatment. It is not known if XOLAIR is safe and effective in people with CSU under 12 years of age.",
			2: "Chronic spontaneous urticaria (CSU, previously referred to as chronic idiopathic urticaria (CIU), chronic hives without a known cause) in people 12 years of age and older who continue to have hives that are not controlled with H1 antihistainine treatment. It is not known if XOLAIR is safe and effective in people with CSU under 12 years of age.",
			"chronic-rhinosinusitis-with-nasal-polyps-(crswnp)-in-people-18-years-of-age-and-older-when-medicines-to-treat-chronic-rhinosinusitis-with-nasal-polyps-called-nasal-corticosteroids-have-not-worked-well-enough.-it-is-not-known-if-xolair-is-safe-and-effective-in-people-with-crswnp-under-18-years-of-age.-xolair-is-not-used-to-treat-other-allergic-conditions,-other-forms-of-hives,-or-sudden-breathing-problems.":
			"Chronic rhinosinusitis with nasal polyps (CRSwNP) in people 18 years of age and older when medicines to treat chronic rhinosinusitis with nasal polyps called nasal corticosteroids have not worked well enough. It is not known if XOLAIR is safe and effective in people with CRSwNP under 18 years of age.",
			3: "Chronic rhinosinusitis with nasal polyps (CRSwNP) in people 18 years of age and older when medicines to treat chronic rhinosinusitis with nasal polyps called nasal corticosteroids have not worked well enough. It is not known if XOLAIR is safe and effective in people with CRSwNP under 18 years of age.",
			"food-allergy-in-people-1-year-of-age-and-older-to-reduce-allergic-reactions-that-may-occur-after-accidentally-eating-one-or-more-foods-to-which-you-are-allergic.-while-taking-xolair-you-should-continue-to-avoid-all-foods-to-which-you-are-allergic.-it-is-not-known-if-xolair-is-safe-and-effective-in-people-with-food-allergy-under-1-year-of-age.-xolair-should-not-be-used-for-the-emergency-treatment-of-any-allergic-reactions,-including-anaphylaxis.-xolair-should-also-not-be-used-to-treat-other-forms-of-hives,-or-sudden-breathing-problems.":
			"Food Allergy",
			4: "Food Allergy",
		};

		const mapped_patients = patients.map(function (search_result) {
			const enrollment_data = JSON.parse(search_result?.enrollment_data || "{}");
			const patient_provider_data = JSON.parse(search_result?.patient_provider_data || "{}");
			const provider_data = JSON.parse(search_result?.provider_data || "{}");
			const lap = enrollment_data?.lap || "{}";
			const commercial_insurance = enrollment_data?.commercial_insurance || "{}";
			const benefits_amounts = JSON.parse(search_result?.benefits_amounts || "{}");
			const card_data = JSON.parse(search_result?.card_data || "{}");
			const verification_data = JSON.parse(search_result?.verification_data || "{}");
			const eligibility_data = JSON.parse(search_result?.eligibility_data || "{}");
			const drugMedicareNum = typeof eligibility_data?.drug?.answer_05 === "string" ? eligibility_data.drug.answer_05.split(",")[2] || "" : "";
			const adminMedicareNum = typeof eligibility_data?.admin?.answer_05 === "string" ? eligibility_data.admin.answer_05.split(",")?.[2] || "" : "";
			const medicare_answers = `${drugMedicareNum.length > 0 ? drugMedicareNum : adminMedicareNum.length > 0 ? adminMedicareNum : ""}`;
			return {
				"Member ID": search_result?.member_id || "",
				"First Name": enrollment_data?.first_name || "",
				"Last Name": enrollment_data?.last_name || "",
				"Date of Birth": enrollment_data?.date_of_birth || "",
				"Enrollment Status": search_result?.enrollment_status || "",
				"Prior Member ID": search_result?.prior_member_id || "",
				Gender: enrollment_data?.gender || "",
				"Drug Patient": search_result?.drug_patient || "",
				"Drug Indication": indication_mapping[eligibility_data?.drug?.answer_03] || "",
				"Drug Admin Patient": search_result?.drug_admin_patient || "",
				"Drug Admin Indication":
				indication_mapping[
					eligibility_data?.admin?.answer_03?.toString().toLowerCase() ?? eligibility_data?.drug_admin?.answer_03?.toString().toLowerCase()
				] || "",
				"Original Enrollment Date Drug": search_result?.original_enrollment_date_drug || "",
				"Original Enrollment Date Drug Admin": search_result?.original_enrollment_date_drug_admin || "",
				"Current Enrollment Date Drug": search_result?.current_enrollment_date_drug || "",
				"Current Enrollment Date Drug Admin": search_result?.current_enrollment_date_drug_admin || "",
				"Enrollment Source": search_result?.enrollment_source || "",
				Address: `${enrollment_data?.address?.address_1 || ""}${enrollment_data?.address?.address_2 || ""}`.trim(),
				City: enrollment_data?.address?.city || "",
				State: enrollment_data?.address?.state || "",
				Zipcode: enrollment_data?.address?.zip_code || enrollment_data?.address["Zip Code"] || search_result.zip_code_v || "",
				Phone: enrollment_data?.phone || lap?.phone || enrollment_data?.phone_number || lap?.phone_number || "",
				Email: enrollment_data?.email || lap?.email || "",
				"Database ID": search_result?.patient_id || "",
				"Card Pii": enrollment_data?.card_pii || "",
				"Eligibility Data": eligibility_data || "",
				Medicare: medicare_answers || "",
				patient_enrollment: enrollment_data || "",
				provider_data: provider_data || "",
				patient_lap: lap || "",
				patient_provider_data: patient_provider_data || "",
				patient_commercial_insurance: commercial_insurance || "",
				patient_benefits_amounts: benefits_amounts || "",
				card_data: card_data || "",
				verification_data: verification_data || "",
				credentials_id: search_result?.credentials_id || "",
				"Enrollment End Date": search_result?.enrollment_end_date || "",
				"Enrollment Status Reason": enrollment_data?.enrollment_status_reason || "",
			};
		});
		return mapped_patients;
	},

	patient_lookup: async (inputText, selectedOptionValue, start_date, end_date) => {
		try {
			let start
			let end
			// clear store to free up memory
			await clearStore()

			// search text and option value blank so validate for searching by enrollment date
			if (!inputText && !selectedOptionValue) {
				// validate date fields for enrollment search
				if (!start_date && !end_date) {
					showAlert("Please enter a start and end date range.")
					return [];
				};
				if (!start_date) {
					showAlert("Please enter a start date.")
					return [];
				};
				if (!end_date) {
					showAlert("Please enter an end date.")
					return [];
				};
			};

			// start and end dates blank so validate regular lookup
			if (!start_date && !end_date)	{
				if (!inputText) {
					// validate fields for input text search 
					showAlert("Please enter text value to search.");
					return [];		
				}
			};

			let search_results = [];

			if (start_date && end_date) {
				showAlert("Searching enrollments from " + start_date + " to " + end_date);
				// start_date = "'" + start_date.toString() + "'";
				// end_date = "'" + end_date.toString() + "'";
				storeValue('enrollment_start_date', start_date);
				storeValue('enrollment_end_date', end_date);
				showAlert("getting search results")

				await get_patients_by_enrollment_dt.run({start_date: start_date, end_date: end_date});
				search_results = get_patients_by_enrollment_dt.data;
			} else {
				if (selectedOptionValue === "member_id") {
					try {
						start = performance.now()
						const res = await get_patient_by_member_id.run({member_id: inputText})
						end = performance.now()
						search_results.push(res);
					} catch (err) {
						showAlert("No patients found")
						return
					}
				} else if ( selectedOptionValue === "patient_id") {
					try {
						const res = await get_patient_by_patient_id.run({patient_id: inputText})
						search_results.push(res);}
					catch (e) {
						showAlert("No patients found")
						return
					}
				} else {
					if (selectedOptionValue === "dob") {
						inputText = this.convertDOB(inputText);
					}
					search_results = await patient_search_api.run( {selected_option_value: selectedOptionValue, input_text: inputText});	
					if (search_results.length === 0) { showAlert("No patients found"); return; }
				}
			}

			showAlert(`${search_results.length} patients found, mapping results`)

			const mapped_patients = this.map_patient(search_results);
			console.log("time", end - start)
			// CLEAR NOTES 
			get_patient_notes.run({patient_id: ""});
			get_bps_notes.run({patient_id: ""});			
			storeValue("mapped_patients", mapped_patients);
			return mapped_patients;
		} catch (e) {
			showAlert(e.message);
			return [];
		}
	},
	lookup_pending_duplicate_patient_status: 	async () => {
		showAlert("getting search results")
		await get_patients_pend_dup_status.run();
		const search_results = get_patients_pend_dup_status.data;
		showAlert("mapping search results")
		const mapped_patients = this.map_patient(search_results);
		storeValue("mapped_patients", mapped_patients);
	},
	convertDOB: (dob) => {
		const newDOB = new Date(dob);
		try {
			if (newDOB.getTime() <= new Date().getTime()) {
				return newDOB.toISOString().split("T")[0];
			} else {
				return new Date(newDOB.setFullYear(newDOB.getFullYear() - 100)).toISOString().split("T")[0];
			}
		} catch (e) {
			return dob;
		}
	},
	get_attestation: async (tab_name, patient_id) => {
		await get_patient_attestation.run({patient_id: patient_id});
		const attestation = get_patient_attestation.data[0];
		// await setTimeout(showAlert("Processing"), 1500);
		// showAlert(get_patient_attestation.data.length);
		if (get_patient_attestation.data.length == 0) {
			storeValue("attestation_obj", {"provider_npi": "", "spoke_with": "", "date_of_attestation": ""});
			// attestation_has_gov_ins_sel.setValue("");
			attestation_spoke_with_inp.setValue("");
			attestation_date_pkr = null;
		} else {
			storeValue("attestation_obj", {"provider_npi": attestation.provider_npi, "spoke_with": attestation.spoke_with, 
																		 "date_of_attestation": attestation.date_of_attestation});				
		}

	},
	update_active_tab: async (tab_name, id) => {
		const patient_id = id.toString();
		// put this code in on row select for patient lookup table: patient_helper_obj.update_active_tab(detail_tab.selectedTab);
		if ( "Patient Detail" == tab_name.trim() ) { 
			// don't need to do anything, data being pulled from objects in selected row from Patient Lookup Table
			await get_patient_attestation.run({patient_id: patient_id});
		} else if ("Communications" == tab_name.trim() ) {
			await this.get_patient_communication_details(patient_id);
		} else if ( "Claims" == tab_name.trim() ) {
			showAlert("Fetching claims, may take up to 30s for results to populate")
			await this.get_patient_claims_details(patient_id);
		} else if ( "Notes" == tab_name.trim() ) {
			await get_patient_notes.run({patient_id: patient_id});
		} else if ( "Insurance" == tab_name.trim() ) {
			await this.display_insurance_info(patient_id);
		} else if ( "Omni Check" == tab_name.trim() ) {
			const omni_check_history = await this.get_patient_omni_check_history(id);
			storeValue("omni_check_obj", omni_check_history);
		} else if ( "BPS Notes" == tab_name.trim() ) {
			await get_bps_notes.run({patient_id: patient_id});
			await get_patient_maximizer_program.run({patient_id: patient_id})
			await get_bps_history.run({patient_id: patient_id})
		}

		// } else if (tab_name == "Attachments") {
		// await get_patient_attachments.run({patient_id: patient_lookup_table.selectedRow["Database ID"]}) }
	},
	display_insurance_info: async (id) => {

		if (!id) return [];
		// id = patient_lookup_table.selectedRow["Database ID"];
		// display 
		await get_patient_insurance.run({patient_id: id}); 
	},
	add_insurance: async (patient_id, insurance_type, plan_name, plan_type, plan_bin, plan_pcn, plan_group, plan_id, plan_start_date, plan_end_date, commercial_or_government) => {

		if (!patient_id) {
			showAlert("Patient Name Must be Selected");
			return
		}
		if (!insurance_type || !plan_name || !plan_type || !plan_bin || !plan_pcn || !plan_group || 
				!plan_id || !plan_start_date || !plan_end_date || !commercial_or_government) {
			showAlert("All Fields Must Not Be Empty, Null, or be 0");
			return;
		}
		try {
			add_patient_insurance.run({
				patient_id: patient_id, insurance_type: insurance_type, plan_name: plan_name, plan_type: plan_type, 
				plan_bin: plan_bin, plan_pcn: plan_pcn, plan_group: plan_group, plan_id: plan_id, plan_start_date: plan_start_date, 
				plan_end_date: plan_end_date, commercial_or_government: commercial_or_government	
			})
			await log.run({action_type: constants.add_insurance, ref_id: patient_id, ref_id_type: constants.patient_id, change_json: JSON.stringify(add_patient_insurance.data) });		
			await get_patient_insurance.run({patient_id: patient_id});	
			showAlert("Insurance Added Successfully");
			closeModal('mdlAddInsurance');
		} catch (e) {
			showAlert("Error adding insurance " + e.name + e.message);
		}

	},
	update_insurance: async (o) => {
		// id, patient_id, insurance_type, plan_name, plan_type, plan_bin, plan_pcn, plan_group, plan_id, plan_start_date, plan_end_date, commercial_or_government, created

		if (!o.id) {
			showAlert("Patient Insurance Name Must be Selected");
			return
		}
		if (!o.patient_id || !o.insurance_type || !o.plan_name || !o.plan_type || !o.plan_bin || !o.plan_pcn || !o.plan_group || 
				!o.plan_id || !o.plan_start_date || !o.plan_end_date || !o.commercial_or_government || !o.created) {
			showAlert("All Fields Must Not Be Empty, Null, or be 0");
			return;
		}
		if (o.insurance_type != "Medical" & o.insurance_type != "Pharmacy") {
			showAlert("Insurance Type must be Medical or Pharmacy");
			return;			
		}

		if (!moment(o.plan_start_date, "YYYY-MM-DD", true).isValid()) {
			showAlert("Plan Start Date must be a valid date in the YYYY-MM-DD format");
			return;					
		}

		if (!moment(o.plan_end_date, "YYYY-MM-DD", true).isValid()) {
			showAlert("Plan End Date must be a valid date in the YYYY-MM-DD format");
			return;					
		}

		update_patient_insurance.run({
			id: o.id, patient_id: o.patient_id, insurance_type: o.insurance_type, plan_name: o.plan_name, plan_type: o.plan_type, 
			plan_bin: o.plan_bin, plan_pcn: o.plan_pcn, plan_group: o.plan_group, plan_id: o.plan_id, plan_start_date: o.plan_start_date, 
			plan_end_date: o.plan_end_date, commercial_or_government: o.commercial_or_government	
		})
		showAlert("Insurance Updated Successfully");
		await log.run({action_type: constants.update_insurance, ref_id: patient_lookup_table.selectedRow["Member ID"], ref_id_type: constants.member_id, change_json: JSON.stringify({old: o, new: {
			id: o.id, patient_id: o.patient_id, insurance_type: o.insurance_type, plan_name: o.plan_name, plan_type: o.plan_type, 
			plan_bin: o.plan_bin, plan_pcn: o.plan_pcn, plan_group: o.plan_group, plan_id: o.plan_id, plan_start_date: o.plan_start_date, 
			plan_end_date: o.plan_end_date, commercial_or_government: o.commercial_or_government	
		}}) });		

		insurance_tbl.updatedRowIndices.pop();
		await get_patient_insurance.run({patient_id: o.patient_id});
	},
	confirm_update_card_status: (confirm) => {
		showAlert(confirm);
		if (confirm !== 'confirm') {
			showAlert("Your input ''" + confirm + "' does not match 'confirm'. Please retype and try again.");
			return;
		}

		this.update_card_status(appsmith.store.patient_id, appsmith.store.patient_status);
	},
	update_card_status: async (member_id, card_status) => {
		// only updates card status at paysign
		if (!member_id) {
			showAlert("Patient must be Selected in Lookup Table");
			return;
		}
		if (!status) {
			showAlert("Please Select a Card Status");
			return;
		}
		try {

			await update_card_status_api.run({member_id: member_id, card_status: card_status});
			card_status === "I" ?
				await log.run({action_type: constants.update_paysign_card_status_inactive, ref_id: patient_lookup_table.selectedRow["Member ID"], ref_id_type: constants.member_id, change_json: JSON.stringify(update_card_status_api.data) }) : await log.run({action_type: constants.update_paysign_card_status_active, ref_id: patient_lookup_table.selectedRow["Member ID"], ref_id_type: constants.member_id, change_json: JSON.stringify(update_card_status_api.data) })
			showAlert("Card Update Successful \n" + status);
		} catch(e) {
			showAlert("Card Update Failed " + e.message + " " + status);
		}
	},
	update_enrollment_status: async (patient_id, member_id, enrollment_status) => {
		// use this to update enrollment status only - leaving drug and drug admin as is
		if (!patient_id) {
			showAlert("Patient must be Selected in Lookup Table");
			return;
		}
		if (!enrollment_status) {
			showAlert("Please Select an Enrollment Status");
			return;
		}
		try {
			await update_patient_enr_status_api.run({patient_id: patient_id, member_id: member_id, enrollment_status: enrollment_status});

			showAlert("Enrollment Status Update Successful \n" + update_patient_enr_status_api.data)
			await log.run({action_type: constants.update_patient_enrollment_status, ref_id: member_id, ref_id_type: constants.member_id, change_json: JSON.stringify(update_patient_enr_status_api.data) })			
		} catch(e) {
			showAlert("Enrollment Status Update Failed " + e.message);
		}
	},
	update_member_id: async (patient_id, new_member_id) => {
		// use this function to update member id
		if (!patient_id) {
			showAlert("Patient must be Selected in Lookup Table");
			return;
		}
		if (!new_member_id) {
			showAlert("Please Enter a new Member ID");
			return;
		}
		try {
			await update_patient_member_id_api.run({patient_id: patient_id, new_member_id: new_member_id});
			showAlert("Enrollment Status Update Successful \n" + update_patient_enr_status_api.data);
		} catch(e) {
			showAlert("Enrollment Status Update Failed " + e.message);
		}
	},	
	get_patient_omni_check_history: async (patient_db_id) => {
		await get_patient_omni_check_history.run({patient_id: patient_db_id});
		const omni_check_results = get_patient_omni_check_history.data;
		if (!omni_check_results) {
			return {
				"User": "",
				"Determination Date": "",
				"Determination": ""

			};
		}

		return omni_check_results.map(function (omni_check_result) {
			const transaction_info = JSON.parse(omni_check_result?.TransactionInfo || "{}");
			showAlert(transaction_info);		
			return {
				"User": transaction_info?.user_name || "",
				"Determination Date": transaction_info?.created || "",
				"Determination": transaction_info?.determination || ""

			};
		});	
	},
	run_omni_check_min: async (o) => {
		console.log(o);
		if (!o) {
			showAlert("Patient Must be Selected in Patient Lookup Table");
			return;
		}
		// const o = patient_obj;
		// turn any id int into string for storing later (may need to convert back to int to find match in orginal table)
		const patient_db_id = o["Database ID"].toString();
		const member_id = o["Member ID"]
		const first_name = o["First Name"];
		const last_name = o["Last Name"];
		const dob = o["Date of Birth"];
		const original_enrollment_status = o["Enrollment Status"];
		let gender = "Female";
		if ("M" === o.Gender.toUpperCase()) gender = "Male";

		const zip = String(o.Zipcode);
		// showAlert((zip))
		if (zip.length < 5 || zip.length > 10) {
			showAlert("Zip code Must be 5 digits.  Please update patient zip code and requery patient lookup table before re-running omni-check. Current zip: " + zip + " length " + zip.length)
			return
		}

		const payload = {
			"PatientPersonalInfo": {
				"FirstName": first_name,
				"LastName": last_name,
				"DateOfBirth": dob,
				"Gender": gender,
				"City": o?.City || "",
				"State": o?.State || "",
				"Zipcode": zip,
				"Email": "",
				"PhoneNumber": o?.Phone || ""
			},
			"PatientMedicalInsurance": {
				"name": o?.patient_commercial_insurance?.medical_insurance?.name || "",
				"plan_type": o?.patient_commercial_insurance?.medical_insurance?.plan_type || "",
				"member_number": o?.patient_commercial_insurance?.medical_insurance?.member_number || "",
				"effective_date": o?.patient_commercial_insurance?.medical_insurance?.effective_date || "",
				"group_number": o?.patient_commercial_insurance?.medical_insurance?.group_number || "",
				"bin": o?.patient_commercial_insurance?.medical_insurance?.bin || "",
				"pcn": o?.patient_commercial_insurance?.medical_insurance?.pcn || ""
			},
			"PatientPharmacyInsurance": {
				"payer_name": o?.patient_commercial_insurance?.rx_insurance?.name || "",
				"payer_type": o?.patient_commercial_insurance?.rx_insurance?.plan_type || "",
				"plan_bin": o?.patient_commercial_insurance?.rx_insurance?.bin || "",
				"plan_pcn": o?.patient_commercial_insurance?.rx_insurance?.pcn || "",
				"plan_group": o?.patient_commercial_insurance?.rx_insurance?.group_number || "",
				"plan_id": o?.patient_commercial_insurance?.rx_insurance?.member_number || "",
				"plan_start_date": "",
				"plan_end_date": ""
			},
			"CardRequestInfo": {
				"Type": ""
			}
		}

		console.log(payload)

		let eligibility;
		let sent_json;
		try {
			const res = await this.get_aws_token_and_run_omni_check(payload); 

			// showAlert(res);
			// showAlert(res.responseMeta.isExecutionSuccess);
			console.log("res " + res)
			//console.log(res.statusCode)
			// console.log(JSON.parse(res).statusCode)
			console.log('EnrollmentStatus', res?.TransactionInfo?.EnrollmentStatus);
			eligibility = res?.TransactionInfo?.EnrollmentStatus || null;
			if (!eligibility) {
				showAlert("No eligibility result returned " + JSON.stringify(res));
				console.log("eligibility returned null")
			}
			//const eligibility_json = JSON.parse(eligibility)
			//console.log("eligibility" + JSON.stringify(eligibility))
			//console.log(eligibility_json.statusCode)
			// console.log(res.statusCode)
			// console.log(res.TransactionInfo.statusCode)
			sent_json = payload
			console.log('sent json' + JSON.stringify(sent_json))
			try {
				// save result to database
				await add_omni_check_result.run({user_name: appsmith.user.email, patient_id: patient_db_id, determination: eligibility, submission_json: 	JSON.stringify(sent_json), response_json: JSON.stringify(res)});

				await log.run({action_type: constants.omnicheck, ref_id: patient_db_id, ref_id_type: constants.patient_id, change_json: JSON.stringify(add_omni_check_result.data) })			

				let enrollment_status;
				if ('eligible' === eligibility?.toLowerCase() || "") {
					// automatically make patient status active if eligibility passed
					enrollment_status = 'Active';
					// update enrollment status and card status
					// await this.confirm_and_update_enrollment_status: async (confirm_text, new_enrollment_status, enrollment_status_reason)
					await this.confirm_and_update_enrollment_status('confirm', enrollment_status, "OC Eligible"); 
					// await this.update_enrollment_status(patient_db_id, member_id, enrollment_status);
					showAlert("Determination: Eligible. Patient Enrollment and Card Status will be Automatically Updated to Active");

					// } else if ('not ineligible' === eligibility?.toLowerCase() || "") {
					// // automatically make patient status inactive if  is determined not eligible
					// enrollment_status = 'Inactive';
					// await this.update_enrollment_status(patient_db_id, member_id, enrollment_status);
					// showAlert("Determination: Not Eligible. Patient Enrollment Status will be Automatically Updated to Inactive");	
				} else if ('not eligible' === eligibility?.toLowerCase() || "") {
					// automatically make patient status inactive if eligibility is determined not eligible
					enrollment_status = 'Inactive';
					// await this.confirm_and_update_enrollment_status('confirm', enrollment_status);	
					await this.confirm_and_update_enrollment_status('confirm', enrollment_status, "OC Fail"); 					
					// await this.update_enrollment_status(patient_db_id, member_id, enrollment_status);
					showAlert("Determination: " + eligibility + ". Patient Enrollment and Card Status will be Automatically Updated to Inactive");	
					// showAlert("Determination: " + eligibility);
				} else if ('not determined' === eligibility?.toLowerCase() || "") {
					// keep same patient status inactive if eligibility not determined
					showAlert("Determination: " + eligibility + ". Patient Enrollment and Card Status will remain " + original_enrollment_status);	
					// showAlert("Determination: " + eligibility);
				} else {
					showAlert("Invalid omni check response - Please escalate to IT")
				}
				// refresh patient omni-check history data
				this.get_patient_omni_check_history(patient_db_id);			

			}	catch (e) {
				showAlert( "Omni-Check Save Unsuccessful " + e.message );
				return {
					"User": "",
					"Determination Date": "",
					"Determination": ""

				};
			}

		} catch (e) {
			showAlert("Error during omni-check " + e.message);
			return {
				"User": "",
				"Determination Date": "",
				"Determination": ""

			};
		}
	},
	get_aws_token_and_run_omni_check: async (payload) => {
		await get_aws_omni_check_credentials.run();
		const credentials = get_aws_omni_check_credentials.data;
		if (!credentials) {
			showAlert("Unable to retrieve Credentials for AWS Token Call");
			return;
		}
		// const credentials = [{pw_key: "2b1nfh45a70am0r6mk9fgtg98f", "pw_secret":" 39qtbcba5363261i3m1i5ff93i8tjs1psam1n795sd15tl9obk3"}]
		const omni_check_url = "https://api.prevail1.com/xolair/new-enrollment"
		const aws_token_url = "https://prevailone.auth.us-west-2.amazoncognito.com/oauth2/token"

		const key = credentials[0].pw_key;
		const secret = credentials[0].pw_secret;
		let access_token = "";
		let token_type = "";
		// get token first
		await fetch(aws_token_url, {
			method: 'POST',
			body: 'grant_type=client_credentials&client_id=' + key + '&client_secret=' + secret,
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			}
		}).then(function (resp) {
			// Return the response as JSON
			return resp.json();
		}).then(function (data) {
			// Log the API data
			// console.log('token', data);
			access_token = data?.access_token;
			token_type = data?.token_type;
		}).catch(function (err) {
			// Log any errors
			console.log('something went wrong', err);
		});		

		// console.log("aws access token" + access_token)
		// use token to run omni-check
		return await fetch(omni_check_url, {
			method: 'POST',
			body: JSON.stringify(payload),
			headers: {
				'Content-Type': 'application/json',
				'Authorization': token_type + " " + access_token,
				'Connection': 'keep-alive',
				'Accept-Encoding': 'Accept-Encoding',
				'Accept': '*/*',
			}
		}).then(function (resp) {
			// Return the response as JSON
			return resp.json();
		}).then(function (data) {
			// Log the API data
			console.log('omni-check result', data);
			console.log('EnrollmentStatus', data?.TransactionInfo?.EnrollmentStatus);
			// return omni check results as json object
			return data;
		}).catch(function (err) {
			// Log any errors
			console.log('something went wrong during omnicheck', err);
			return {};
		});			
	},
	add_new_attestation: async(attestation_obj) => {
		const patient_id = attestation_obj.patient_id;
		const provider_npi = attestation_obj.provider_npi;
		const spoke_with = attestation_obj.spoke_with;
		const covered_by_government_insurance = attestation_obj.covered_by_government_insurance;
		const date_of_attestation = attestation_obj.date_of_attestation;
		const provider_type = attestation_obj.provider_type;
		const demographic_confirmed = attestation_obj.demographic_confirmed;
		const attest_to_not_use_gov_reimbursement = attestation_obj.attest_to_not_use_gov_reimbursement;		

		// showAlert(JSON.stringify(attestation_obj));

		if (!patient_id) {
			showAlert("Please select a patient in the lookup table and make sure it is highlighted");
			return;
		};

		if (!provider_npi || !spoke_with || !covered_by_government_insurance || !date_of_attestation || !provider_type || !demographic_confirmed || !attest_to_not_use_gov_reimbursement) {
			showAlert("All fields must be completed and have a value");
			return;
		};
		let isnum = provider_npi.match(/^[0-9]+$/) !== null;
		if (provider_npi.length != 10 || !isnum) {
			showAlert("Provider NPI Must be 10 digits");
			return;
		};

		// add new one
		try {
			add_patient_attestation.run({user_name: appsmith.user.username, patient_id: patient_id, provider_npi: provider_npi, spoke_with: spoke_with, covered_by_government_insurance: covered_by_government_insurance, date_of_attestation: date_of_attestation, provider_type: provider_type, demographic_confirmed: demographic_confirmed, attest_to_not_use_gov_reimbursement: attest_to_not_use_gov_reimbursement});
			// call get api to refresh table
			get_patient_attestation.run({patient_id: patient_id});
			showAlert("Add Patient Provider Attestation Successful");

			// check questionnaire to qualify for auto-activation of patient enrollment and card 
			if (provider_type == "PO" && demographic_confirmed == 'Y' && attest_to_not_use_gov_reimbursement == 'Y') {
				const enrollment_status = 'Active';
				// update enrollment status and card status
				await this.confirm_and_update_enrollment_status('confirm', enrollment_status, "Provider Attestation"); 
				// await this.update_enrollment_status(patient_db_id, member_id, enrollment_status);
				showAlert("Attestation Succes: Eligible. Patient Enrollment and Card Status will be Automatically Updated to Active");				
			}

		} catch (e) {
			showAlert("Error while adding patient provider attestation " + e.message);
		}


	},
	update_attestation: async(attestation_obj) => {
		// patient_id, provider_npi, spoke_with, date_of_attestation
		const id = attestation_obj.id;
		const patient_id = attestation_obj.patient_id;
		const provider_npi = attestation_obj.provider_npi;
		const spoke_with = attestation_obj.spoke_with;
		const covered_by_government_insurance = attestation_obj.covered_by_government_insurance;
		const date_of_attestation = attestation_obj.date_of_attestation;
		const provider_type = attestation_obj.provider_type;
		const demographic_confirmed = attestation_obj.demographic_confirmed;
		const attest_to_not_use_gov_reimbursement = attestation_obj.attest_to_not_use_gov_reimbursement;		

		showAlert(JSON.stringify(attestation_obj));

		if (!patient_id) {
			showAlert("Please select a patient attestation in the attestation history table and make sure it is highlighted");
			return;
		};

		if (!provider_npi || !spoke_with || !covered_by_government_insurance || !date_of_attestation || !provider_type || !demographic_confirmed || !attest_to_not_use_gov_reimbursement) {
			showAlert("All fields must be completed and have a value");
			return;
		};
		let isnum = provider_npi.match(/^[0-9]+$/) !== null;
		if (provider_npi.length != 10 || !isnum) {
			showAlert("Provider NPI Must be 10 digits");
			return;
		};
		// previous attestation, just update
		try {
			update_patient_attestation.run({id: id, user_name: appsmith.user.username, patient_id: patient_id, provider_npi: provider_npi, spoke_with: spoke_with, covered_by_government_insurance: covered_by_government_insurance, date_of_attestation: date_of_attestation, provider_type: provider_type, demographic_confirmed: demographic_confirmed, attest_to_not_use_gov_reimbursement: attest_to_not_use_gov_reimbursement});
			get_patient_attestation.run({patient_id: patient_id});
			showAlert("Update Patient Provider Attestation Successful");

			// check questionnaire to qualify for auto-activation of patient enrollment and card 
			if (provider_type == "PO" && demographic_confirmed == 'Y' && attest_to_not_use_gov_reimbursement == 'Y') {
				const enrollment_status = 'Active';
				// update enrollment status and card status
				await this.confirm_and_update_enrollment_status('confirm', enrollment_status, "Provider Attestation"); 
				// await this.update_enrollment_status(patient_db_id, member_id, enrollment_status);
				showAlert("Attestation Succes: Eligible. Patient Enrollment and Card Status will be Automatically Updated to Active");				
			}			
		} catch (e) {
			showAlert("Error while updating patient provider attestation " + e.message);
		}
	},
	save_attestation: async (attestation_obj) => {
		// used previously for logic to only store 1 attestation per patient - cannot use for multiple attestations
		// patient_id, provider_npi, spoke_with, date_of_attestation
		const patient_id = attestation_obj.patient_id;
		const provider_npi = attestation_obj.provider_npi;
		const spoke_with = attestation_obj.spoke_with;
		const covered_by_government_insurance = attestation_obj.covered_by_government_insurance;
		const date_of_attestation = attestation_obj.date_of_attestation;
		const provider_type = attestation_obj.provider_type;
		const demographic_confirmed = attestation_obj.demographic_confirmed;
		const attest_to_not_use_gov_reimbursement = attestation_obj.attest_to_not_use_gov_reimbursement;		

		showAlert(JSON.stringify(attestation_obj));

		if (!patient_id) {
			showAlert("Please select a patient in the lookup table and make sure it is highlighted");
		};

		if (!provider_npi || !spoke_with || !covered_by_government_insurance || !date_of_attestation || !provider_type || !demographic_confirmed || !attest_to_not_use_gov_reimbursement) {
			showAlert("All fields must be completed and have a value");
		};
		let isnum = provider_npi.match(/^[0-9]+$/) !== null;
		if (provider_npi.length != 10 || !isnum) {
			showAlert("Provider NPI Must be 10 digits");
		};

		// check if previous attestation exists so as to add or update (only 1 attestation per patient)
		await get_patient_attestation.run({patient_id: patient_id});
		const previous_attestation = get_patient_attestation.data; 
		if (previous_attestation.length == 0) {
			// no previous attestation, add new one
			try {
				add_patient_attestation.run({user_name: appsmith.user.username, patient_id: patient_id, provider_npi: provider_npi, spoke_with: spoke_with, covered_by_government_insurance: covered_by_government_insurance, date_of_attestation: date_of_attestation, provider_type: provider_type, demographic_confirmed: demographic_confirmed, attest_to_not_use_gov_reimbursement: attest_to_not_use_gov_reimbursement});
				get_patient_attestation.run({patient_id: patient_id});
				showAlert("Add Patient Provider Attestation Successful");
			} catch (e) {
				showAlert("Error while adding patient provider attestation " + e.message);
			}

		} else {
			// previous attestation, just update
			try {
				update_patient_attestation.run({user_name: appsmith.user.username, patient_id: patient_id, provider_npi: provider_npi, spoke_with: spoke_with, covered_by_government_insurance: covered_by_government_insurance, date_of_attestation: date_of_attestation, provider_type: provider_type, demographic_confirmed: demographic_confirmed, attest_to_not_use_gov_reimbursement: attest_to_not_use_gov_reimbursement});
				get_patient_attestation.run({patient_id: patient_id});
				showAlert("Update Patient Provider Attestation Successful");
				showAlert("Update Patient Provider Attestation Successful");
			} catch (e) {
				showAlert("Error while updating patient provider attestation " + e.message);
			}

		}
	},
	get_card_status: async(patient_id) => {

		// code to get card status from db - which may not be updated -
		if (!patient_id) {
			showAlert("Please select and highlight a patient to change card status");
			return;
		}
		await paysign_get_card_details.run({member_id: patient_lookup_table.triggeredRow["Member ID"]});	
		// await patient_lookup_id_api.run({id: patient_id});
		// const card_data = JSON.parse(patient_lookup_id_api.data?.card_data);
		// const card_data = JSON.parse(paysign_get_card_details.data);
		const card_data = paysign_get_card_details.data;
		// showAlert("card data" + card_data);
		if (!card_data) {
			showAlert("Patient does not have an associated card");
			storeValue("card_status", null)
			return;
		}
		// const card_status = card_data.response?.card_data?.cardStatus;
		const card_status = card_data.card_status;
		showAlert("Current Card Status at Paysign is: " + card_status);
		// storeValue("card_status", card_status); 
		// card_status_sel.selectedOptionValue = 
	},
	update_patient: async (patient_id, member_id, enrollment_status, update_enrollment_data) => {
		try {
			if (!patient_id || !member_id || !enrollment_status || !update_enrollment_data || update_enrollment_data === {}) {
				showAlert("Must have a patient row selected in order to update patient data")
				return
			}

			// update to hopefully prevent records clearing out with weird selectedRow bug after clicking same row fast
			// if (!update_enrollment_data?.first_name) {
			// showAlert("Sorry, it seems the row did not select properly. Please unselect the row, wait a second, reselect it, and try again.")
			// return
			// }

			const patient_data = await patient_lookup_id_api.run({id: patient_id})

			// update to hopefully prevent records clearing out with weird selectedRow bug after clicking 2 diff rows fast
			// if (patient_data?.member_id?.toString() !== member_id?.toString()) {
			// showAlert("Sorry, it seems the row did not select properly and incorrect info is being used in the update. Please unselect the row, wait a second, reselect it, and try again.")
			// return
			// }

			const enrollment_data = JSON.parse(patient_data?.enrollment_data || "{}")
			const old_enrollment_data = JSON.parse(JSON.stringify(enrollment_data))

			enrollment_data.first_name = update_enrollment_data?.first_name || ""
			enrollment_data.last_name = update_enrollment_data?.last_name || ""
			enrollment_data.date_of_birth = update_enrollment_data?.date_of_birth || ""
			if (enrollment_data.phone_number) enrollment_data.phone_number = update_enrollment_data?.phone || ""
			else enrollment_data.phone = update_enrollment_data?.phone || ""
			enrollment_data.gender = update_enrollment_data?.gender || ""
			enrollment_data.email = update_enrollment_data?.email || ""
			if (enrollment_data.address === null || enrollment_data.address === undefined) {
				enrollment_data.address = {}
			}
			enrollment_data.address.address_1 = update_enrollment_data?.address?.address_1?.toString().trim() || ""
			enrollment_data.address.address_2 = update_enrollment_data?.address?.address_2?.toString().trim() || ""
			enrollment_data.address.city = update_enrollment_data?.address?.city?.toString().trim() || ""
			enrollment_data.address.state = update_enrollment_data?.address?.state?.toString().trim() || ""
			enrollment_data.address.zip_code = update_enrollment_data?.address?.zip_code?.toString().trim() || ""

			if (enrollment_data.lap === null || enrollment_data.lap === undefined) {
				enrollment_data.lap = {}
			}
			enrollment_data.lap.first_name = update_enrollment_data?.lap?.first_name?.toString().trim() || ""
			enrollment_data.lap.last_name = update_enrollment_data?.lap?.last_name?.toString().trim() || ""
			if (enrollment_data.lap.phone_number) enrollment_data.lap.phone_number = update_enrollment_data?.lap?.phone || ""
			else enrollment_data.lap.phone = update_enrollment_data?.lap?.phone || ""
			if (enrollment_data.lap.address === null || enrollment_data.lap.address === undefined) {
				enrollment_data.lap.address = {}
			}
			enrollment_data.lap.address.address_1 = update_enrollment_data?.lap?.address?.address_1?.toString().trim() || ""
			enrollment_data.lap.address.address_2 = update_enrollment_data?.lap?.address?.address_2?.toString().trim() || ""
			enrollment_data.lap.address.city = update_enrollment_data?.lap?.address?.city?.toString().trim() || ""
			enrollment_data.lap.address.state = update_enrollment_data?.lap?.address?.state?.toString().trim() || ""
			enrollment_data.lap.address.zip_code = update_enrollment_data?.lap?.address?.zip_code?.toString().trim() || ""

			if (enrollment_data.commercial_insurance === null || enrollment_data.commercial_insurance === undefined) {
				enrollment_data.commercial_insurance = {}
			}
			if (enrollment_data.commercial_insurance.medical_insurance === null || enrollment_data.commercial_insurance.medical_insurance === undefined) {
				enrollment_data.commercial_insurance.medical_insurance = {}
			}
			if (enrollment_data.rx_insurance === null || enrollment_data.rx_insurance === undefined) {
				enrollment_data.commercial_insurance.rx_insurance = {}
			}
			enrollment_data.commercial_insurance.medical_insurance.name = update_enrollment_data?.commercial_insurance?.medical_insurance?.name?.toString().trim() || ""
			enrollment_data.commercial_insurance.medical_insurance.plan_type = update_enrollment_data?.commercial_insurance?.medical_insurance?.plan_type?.toString().trim() || ""
			enrollment_data.commercial_insurance.medical_insurance.member_number = update_enrollment_data?.commercial_insurance?.medical_insurance?.member_number?.toString().trim() || ""
			enrollment_data.commercial_insurance.medical_insurance.group_number = update_enrollment_data?.commercial_insurance?.medical_insurance?.group_number?.toString().trim() || ""
			enrollment_data.commercial_insurance.medical_insurance.bin = update_enrollment_data?.commercial_insurance?.medical_insurance?.bin?.toString().trim() || ""
			enrollment_data.commercial_insurance.medical_insurance.pcn = update_enrollment_data?.commercial_insurance?.medical_insurance?.pcn?.toString().trim() || ""
			enrollment_data.commercial_insurance.medical_insurance.effective_date = update_enrollment_data?.commercial_insurance?.medical_insurance?.effective_date?.toString().trim() || ""

			enrollment_data.commercial_insurance.rx_insurance.name = update_enrollment_data?.commercial_insurance?.rx_insurance?.name?.toString().trim() || ""
			enrollment_data.commercial_insurance.rx_insurance.member_number = update_enrollment_data?.commercial_insurance?.rx_insurance?.member_number?.toString().trim() || ""
			enrollment_data.commercial_insurance.rx_insurance.group_number = update_enrollment_data?.commercial_insurance?.rx_insurance?.group_number?.toString().trim() || ""
			enrollment_data.commercial_insurance.rx_insurance.bin = update_enrollment_data?.commercial_insurance?.rx_insurance?.bin?.toString().trim() || ""
			enrollment_data.commercial_insurance.rx_insurance.pcn = update_enrollment_data?.commercial_insurance?.rx_insurance?.pcn?.toString().trim() || ""
			enrollment_data.commercial_insurance.rx_insurance.plan_type = update_enrollment_data?.commercial_insurance?.rx_insurance?.plan_type?.toString().trim() || ""

			const update_patient_request = {
				"patient_id": patient_id, 
				"member_id": member_id, 
				"enrollment_status": enrollment_status, 
				"enrollment_data": JSON.stringify(enrollment_data)
			}
			let update_patient_result;
			try {
				update_patient_result = await update_patient_api.run({"update_payload": update_patient_request});
			} catch (err) {
				update_patient_result = update_patient_api?.data
			} finally {
				await log.run({action_type: constants.update_patient, ref_id: member_id, ref_id_type: constants.member_id, change_json: JSON.stringify({old:old_enrollment_data, new: enrollment_data, request: update_patient_request, response: update_patient_result}) })
			}

			if (update_patient_result?.message === "Patient updated") {
				showAlert("Patient updated successfully, refreshing page view")
				await patient_helper_obj.patient_lookup(patient_lookup_txt.text, patient_lookup_list.selectedOptionValue, "", "")	
			} else {
				showAlert("Unable to update patient at this time - Please escalate to IT")
			}
		} catch (err) {
			console.log(err);
			console.log(err.toString())
			showAlert("Unable to update patient at this time  - Please escalate to IT")
		}
	},
	update_patient_member_group: async (patient_id, member_group) => {
		if (!patient_id) {
			showAlert("Please select and highlight patient in patient lookup table first");
		}
		if (!member_group) {
			showAlert("Please select a member group to update to");
		}
		try {
			// showAlert(patient_id + member_group);
			const response = await update_patient_member_grp_api.run({patient_id: patient_id ,member_group: member_group});
			if (response.response_code == 200) {
				showAlert('Patient Member Group Successfully Updated');	
				await log.run({action_type: constants.update_patient_member_group + " " + member_group, ref_id: patient_id, ref_id_type: constants.patient_id, change_json: JSON.stringify(update_patient_member_grp_api.data) })			

			}	else {
				showAlert("Member Group Update was Not Successful. This is the return response: " + response);
			}		
		} catch (e) {
			// storeValue("message", err.message)
			showAlert(`${update_patient_member_grp_api.data}`);

		}

	},
	link_patient_member_id_to_provider_npi: async(patient_member_id, provider_npi, provider_type) => {
		try {
			// provider_type = appsmith.store.provider_type;
			// showAlert(patient_member_id+provider_npi+provider_type)
			if (!patient_member_id) {
				showAlert("Please select and highlight patient in the patient lookup table.")
				return;
			}; 
			if (!provider_npi) {
				showAlert("Please select and highlight provider in the provider search result.")
				return;
			}; 
			if (!provider_type) {
				showAlert("Please select whether provider is primary or secondary." + provider_type)
				return;
			}; 	
			await link_patient_provider_api.run({patient_member_id: patient_member_id, provider_npi: provider_npi, provider_type: provider_type})
			if (!link_patient_provider_api.data) {
				showAlert("Api did not return any result");
			} else {
				showAlert(link_patient_provider_api.data.message);
				await log.run({action_type: constants.link_patient_to_provider, ref_id: patient_member_id + " " + provider_npi, ref_id_type: constants.member_id + " " + constants.npi, change_json: JSON.stringify(link_patient_provider_api.data) })			
				// showAlert("Patient - Provider linking Successful for " + patient_member_id + " " + provider_npi);				
			}
		} catch (e) {
			console.log(e)

			if (link_patient_provider_api?.data?.message?.toString().toLowerCase() === "validation error") {
				showAlert("Patient - Provider link already exists");
			} else {
				showAlert("Patient - Provider linking failed: "  + e.message);
			}
			return;
		}		
	},	
	link_patient_provider: async (patient_status, member_id, provider_npi, provider_type) => {
		try {
			if (patient_status.toLowerCase() !== "active") return {"message": "Cannot create a link for a patient with Patient Status not Active "}
			else if (!member_id) return {"message": "Appsmith error, unable to link"}
			else if (!provider_npi) return {"message": "Please search and select a provider to link"}
			else if (!provider_type) return {"message": "Please select a Provider Type"}

			const link_patient_provider_response = await link_patient_provider_api.run({"member_id": member_id, "provider_npi": provider_npi, "provider_type": provider_type})
			await log.run({action_type: constants.link_patient_to_provider, ref_id: member_id + " " + provider_npi, ref_id_type: constants.member_id + " " + constants.npi, change_json: JSON.stringify(link_patient_provider_api.data) })			

			if (link_patient_provider_response.result === 0) return {"message": `Member ${member_id} linked to provider with NPI ${provider_npi} as ${provider_type}`}

			return {"message": `Failed to link member ${member_id} to provider with NPI ${provider_npi} as ${provider_type}`}
		} catch (err) {
			console.log(err)

			if (link_patient_provider_api.data === "{\"message\":\"Validation error\"}") return {"message": `Link already exists from member ${member_id} to provider with NPI ${provider_npi} as ${provider_type}`}

			return {"message": `Failed to link member ${member_id} to provider with NPI ${provider_npi} as ${provider_type}`}
		}
	},
	get_patient_profile: async (id) => {
		try {
			if (!id)
				return {
					"First Name": "",
					"Last Name": "",
					"Date of Birth": "",
					Address: "",
					Phone: "",
					Email: "",
				};

			const patient_data = await patient_lookup_id_api.run({ id: id });
			const enrollment_data = JSON.parse(patient_data?.enrollment_data || "{}");

			return {
				"First Name": enrollment_data?.first_name || "",
				"Last Name": enrollment_data?.last_name || "",
				"Date of Birth": enrollment_data?.dob || "",
				Address:
				(enrollment_data.address?.address1 || "") +
				(enrollment_data.address?.city ? ` ${enrollment_data.address?.city}` : "") +
				(enrollment_data.address?.state ? ` ${enrollment_data.address?.state}` : "") +
				(enrollment_data.address?.zip_code ? ` ${enrollment_data.address?.zip_code}` : ""),
				Phone: enrollment_data?.phone || "",
				Email: enrollment_data?.email || "",
				Login: patient_data?.credentials_id,
			};
		} catch (err) {
			console.log(err);
			return {
				"First Name": "",
				"Last Name": "",
				"Date of Birth": "",
				Address: "",
				Phone: "",
				Email: "",
			};
		}
	},
	get_patient_caregiver_info: async (id) => {
		try {
			if (!id)
				return {
					"First Name": "",
					"Last Name": "",
					Address: "",
					Phone: "",
				};
			const patient_data = await patient_lookup_id_api.run({ id: id });
			const enrollment_data = JSON.parse(patient_data?.enrollment_data || "{}");
			return {
				"First Name": enrollment_data.lap?.first_name || "",
				"Last Name": enrollment_data.lap?.last_name || "",
				Address:
				(enrollment_data.lap?.address?.address1 || "") +
				(enrollment_data.lap?.address?.city ? ` ${enrollment_data.lap.address.city}` : "") +
				(enrollment_data.lap?.address?.state ? ` ${enrollment_data.lap.address.state}` : "") +
				(enrollment_data.lap?.address?.zip_code ? ` ${enrollment_data.lap.address.zip_code}` : ""),
				Phone: enrollment_data.lap?.phone || "",
			};
		} catch (err) {
			console.log(err);
			return {
				"First Name": "",
				"Last Name": "",
				Address: "",
				Phone: "",
			};
		}
	},
	get_patient_enrollment_details: async (id) => {
		try {
			if (!id)
				return {
					BIN: "",
					PCN: "",
					Group: "",
					"Member ID": "",
					"Max Benefit": "",
					"Benefit Used": "",
					"Available Benefit": "",
				};

			const patient_data = await patient_lookup_id_api.run({ id: id });
			return {
				BIN: "610020",
				PCN: "PDMI",
				Group: "99995209",
				"Member ID": patient_data?.member_id || "",
				"Max Benefit": patient_data?.total_benefits || 15000,
				"Benefit Used":
				patient_data.total_benefits && patient_data.current_year_available ? patient_data.total_benefits - patient_data.current_year_available : "",
				"Available Benefit": patient_data?.current_year_available || "",
			};
		} catch (err) {
			console.log(err);
			return {
				BIN: "",
				PCN: "",
				Group: "",
				"Member ID": "",
				"Max Benefit": "",
				"Benefit Used": "",
				"Available Benefit": "",
			};
		}
	},
	get_patient_communication_details: async (patient_id) => {
		try {
			if (!patient_id) return [];

			const patient_data = await patient_communications_id_api.run({ patient_id: patient_id });
			const mapped_patient_communications =  patient_data.map((result) => {
				const patient_communication_data = JSON.parse(result?.communication_data || "{}");
				return {
					"Document ID": result?.document_id || "",
					"Member ID": result?.member_id || "",
					"Document Type": result?.document_type || "",
					"Document Name": patient_communication_data?.file_location?.file_name || "",
					"S3 Bucket": patient_communication_data?.file_location?.s3_bucket || "",
					"S3 Key": `${patient_communication_data?.file_location?.s3_folder || ""}${
					patient_communication_data?.file_location?.file_name || ""
				}`.replace("/LTR/", "/LETTERS/"),
					"Document Received Date": result?.document_received_date || "",
					"Document Sent Date": result?.document_sent_date || "",
					"Document Processed Date": result?.document_processed_date || "",
				};
			});
			storeValue("mapped_patient_communications", mapped_patient_communications)
			return mapped_patient_communications
		} catch (err) {
			console.log(err.toString());
			return [];
		}
	},
	get_patient_claims_details: async (patient_id) => {
		try {
			if (!patient_id) return [];
			const patient_data = await patient_claims_patient_id_api.run({ patient_id: patient_id })
			showAlert(`${patient_data.length} claims found, mapping results`)

			const mapped_patient_lookup_claims = patient_data.map((result) => {
				const claim_data = JSON.parse(result?.claim_data || "{}");
				const payment_type = result?.payment_type?.toUpperCase() || "";

				const date_of_service = utils.getStandardizedDate(result?.date_of_service?.toString()) || "";
				const paid_date = utils.getStandardizedDate(result?.paid_date_v?.toString()) ||"";

				const claim_data_without_providers = {};
				// console.log(Object.keys(result));
				// const refund_data = JSON.parse(result?.refund_data || "{}");
				for (let [key, value] of Object.entries(claim_data)) {
					if (key === "providers") continue;
					else if (key === "notes") continue;
					else if (key === "patient_data") continue;
					else if (key === "provider_data") continue;
					else if (key === "check_response") continue;
					else if (key === "paysign_api_data") continue;
					else if (key === "parent_provider_data") continue;

					if (!(typeof value === "object" && !Array.isArray(value) && value !== null)) {
						value = value?.toString() ?? ""

						if (key === "date_of_service") {
							claim_data_without_providers[key] = date_of_service;
						} else if (key === "paid_date") {
							claim_data_without_providers[key] = paid_date;
						} else if (key.includes("date")) {
							claim_data_without_providers[key] = utils.getStandardizedDate(value?.toString() || "");
						} else {
							try {
								claim_data_without_providers[key] = JSON.parse(value);	
							} catch (err) {
								claim_data_without_providers[key] = value
							}
						}
					} else {
						claim_data_without_providers[key] = value || {};
					}


				}

				const providers_data = { prescriber: {}, provider: {}, pharmacy: {} };
				for (const [key, value] of Object.entries(claim_data?.providers || {})) {
					if (!(typeof value === "object" && !Array.isArray(value) && value !== null)) {
						providers_data[key] = value ?? ""
					} else {
						providers_data[key] = value ?? {}
					}
				}

				return {
					"Claim ID": result?.claim_id ?? "",
					"Patient ID": result?.patient_id ?? "",
					"Provider ID": result?.provider_id ?? "",
					"Program": result?.program || "",
					"Payment Type": payment_type,
					"Claim Status": result?.claim_status || "",
					"Payment Status": result?.payment_status || "",
					"Check Num": claim_data?.check_num,
					"Program Benefit": claim_data?.program_benefit ?? claim_data?.benefit_amount ?? "",
					"Date of Service": date_of_service,
					"Paid Date": paid_date,
					"Approved Date": result?.approved_date_v,
					"Requested Date": result?.requested_date_v,
					"Document ID": claim_data?.incoming_document_id,
					claim_data: claim_data_without_providers,
					providers_data: providers_data,
					notes_data: claim_data?.notes || [],
					refund_data : result?.refund_data ?? "",
				};
			});

			console.log(mapped_patient_lookup_claims)

			storeValue("mapped_patient_lookup_claims", mapped_patient_lookup_claims)
			return mapped_patient_lookup_claims
		} catch (err) {
			console.log(err);
			return [];
		}
	}
}