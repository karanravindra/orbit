import { defineErrorCodes } from "better-auth";

// Error codes the local auth plugins return, one group per plugin. Each plugin
// also exposes its group as $ERROR_CODES.

const OWNER_ROLE_RESERVED = "Only the personal owner can have the owner role";

export const PERSONAL_ORGANIZATION_ERROR_CODES = defineErrorCodes({
	CANNOT_LEAVE_PERSONAL_ORGANIZATION:
		"You can't leave your personal organization",
	CANNOT_INVITE_AS_OWNER: OWNER_ROLE_RESERVED,
	CANNOT_ADD_OWNER: OWNER_ROLE_RESERVED,
	CANNOT_ASSIGN_OWNER_ROLE: OWNER_ROLE_RESERVED,
	CANNOT_CHANGE_OWNER_ROLE: "The owner's role can't be changed",
	CANNOT_REMOVE_OWNER:
		"The owner can't be removed from their personal organization",
});

export const MEMBER_GUARD_ERROR_CODES = defineErrorCodes({
	ONLY_OWNERS_AND_ADMINS_CAN_INVITE:
		"Only owners and admins can invite members",
	ONLY_OWNERS_AND_ADMINS_CAN_ASSIGN_ADMIN:
		"Only owners and admins can make someone an admin",
});

export const EMAIL_VERIFICATION_ERROR_CODES = defineErrorCodes({
	OTP_SIGN_IN_DISABLED: "Signing in with an email code is not enabled",
	// Same as the email OTP plugin's own, so a refused code looks like a wrong one.
	INVALID_OTP: "Invalid OTP",
});
