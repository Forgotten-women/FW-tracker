// The attendance dispute / correction form (Spec 11), shared by the home
// screen and the attendance history day view. Moved here unchanged from
// HomeScreen._openCorrectionForm so both open the same flow.

import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../theme.dart';

String _key(DateTime d) =>
    '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// Opens the dispute form, prefilled with [initialDateKey] (today when null),
/// and submits it. Shows the server's reply as a snackbar. Returns true when
/// a request was sent to HR.
Future<bool> showAttendanceCorrectionSheet(
  BuildContext context, {
  required ApiClient api,
  String? initialDateKey,
}) async {
  final now = DateTime.now();
  String selectedDateKey = initialDateKey ?? _key(now);
  final reasonController = TextEditingController();
  final minutesController = TextEditingController();
  String reasonCategory = 'Sensor Glitch / Failed Check-in';

  // The picker normally offers the last 60 days; a day opened from the
  // history can be older, and the picker must include its initial date.
  final initial = DateTime.tryParse(selectedDateKey);
  var firstDate = now.subtract(const Duration(days: 60));
  if (initial != null && initial.isBefore(firstDate)) firstDate = initial;

  final submitted = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.sheet,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (ctx) {
      return StatefulBuilder(
        builder: (context, setModalState) {
          return Padding(
            padding: EdgeInsets.fromLTRB(
              20,
              20,
              20,
              MediaQuery.of(context).viewInsets.bottom + 20,
            ),
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Text(
                          'File Attendance Dispute',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            color: AppColors.textPrimary,
                          ),
                        ),
                      ),
                      IconButton(
                        icon: Icon(Icons.close, color: AppColors.textMuted),
                        onPressed: () => Navigator.pop(ctx, false),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Dispute an inaccurate clock-in, sensor glitch, or authorised absence. Preserved immutably for HR audit.',
                    style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                  ),
                  Divider(height: 24, color: AppColors.border),

                  Text('Affected Date', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: AppColors.textSecondary)),
                  const SizedBox(height: 6),
                  InkWell(
                    onTap: () async {
                      final picked = await showDatePicker(
                        context: context,
                        initialDate: DateTime.tryParse(selectedDateKey) ?? now,
                        firstDate: firstDate,
                        lastDate: now,
                      );
                      if (picked != null) {
                        setModalState(() {
                          selectedDateKey = _key(picked);
                        });
                      }
                    },
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                      decoration: BoxDecoration(
                        color: AppColors.bgDark,
                        border: Border.all(color: AppColors.border),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(child: Text(selectedDateKey, style: TextStyle(fontSize: 13, color: AppColors.textPrimary))),
                          Icon(Icons.calendar_today, size: 16, color: AppColors.primaryLight),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),

                  Text('Dispute Reason Category', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: AppColors.textSecondary)),
                  const SizedBox(height: 6),
                  DropdownButtonFormField<String>(
                    initialValue: reasonCategory,
                    isExpanded: true,
                    dropdownColor: AppColors.sheet,
                    decoration: const InputDecoration(
                      contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                    ),
                    items: [
                      DropdownMenuItem(value: 'Sensor Glitch / Failed Check-in', child: Text('Sensor Glitch / Failed Check-in', overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: AppColors.textPrimary))),
                      DropdownMenuItem(value: 'Wi-Fi / Network Disconnection', child: Text('Wi-Fi / Network Disconnection', overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: AppColors.textPrimary))),
                      DropdownMenuItem(value: 'Off-site Business Meeting', child: Text('Off-site Business Meeting', overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: AppColors.textPrimary))),
                      DropdownMenuItem(value: 'Forgotten Phone / Device', child: Text('Forgotten Phone / Device', overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: AppColors.textPrimary))),
                      DropdownMenuItem(value: 'Approved Overtime / Late Shift', child: Text('Approved Overtime / Late Shift', overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: AppColors.textPrimary))),
                      DropdownMenuItem(value: 'Other Reason', child: Text('Other Reason', overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: AppColors.textPrimary))),
                    ],
                    onChanged: (val) {
                      if (val != null) {
                        setModalState(() => reasonCategory = val);
                      }
                    },
                  ),
                  const SizedBox(height: 14),

                  Text('Proposed Adjustment Minutes (optional)', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: AppColors.textSecondary)),
                  const SizedBox(height: 6),
                  TextField(
                    controller: minutesController,
                    keyboardType: TextInputType.number,
                    style: TextStyle(color: AppColors.textPrimary, fontSize: 13),
                    decoration: InputDecoration(
                      hintText: 'e.g. 30',
                      hintStyle: TextStyle(color: AppColors.textTertiary),
                      suffixText: 'mins',
                      suffixStyle: TextStyle(color: AppColors.textMuted),
                    ),
                  ),
                  const SizedBox(height: 14),

                  Text('Detailed Explanation (Required)', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: AppColors.textSecondary)),
                  const SizedBox(height: 6),
                  TextField(
                    controller: reasonController,
                    maxLines: 3,
                    style: TextStyle(color: AppColors.textPrimary, fontSize: 13),
                    decoration: InputDecoration(
                      hintText: 'Explain what occurred and why attendance should be amended...',
                      hintStyle: TextStyle(color: AppColors.textTertiary),
                    ),
                  ),
                  const SizedBox(height: 20),

                  SizedBox(
                    width: double.infinity,
                    height: 46,
                    child: FilledButton(
                      onPressed: () {
                        if (reasonController.text.trim().isEmpty) {
                          ScaffoldMessenger.of(ctx).showSnackBar(
                            SnackBar(
                              content: const Text('Please enter an explanation.'),
                              backgroundColor: AppColors.danger,
                            ),
                          );
                          return;
                        }
                        Navigator.pop(ctx, true);
                      },
                      style: FilledButton.styleFrom(backgroundColor: AppColors.primary),
                      child: const Text('Submit Dispute to HR', style: TextStyle(fontWeight: FontWeight.bold)),
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      );
    },
  );

  if (submitted != true) return false;

  final fullReason = '[$reasonCategory] ${reasonController.text.trim()}';
  final adjMinutes = int.tryParse(minutesController.text.trim());

  try {
    final msg = await api.submitCorrection(
      dateKey: selectedDateKey,
      reason: fullReason,
      requestedChange: adjMinutes != null ? {'adjustmentMinutes': adjMinutes} : null,
    );
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg), backgroundColor: AppColors.teal),
      );
    }
    return true;
  } on ApiException catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.message), backgroundColor: AppColors.danger),
      );
    }
    return false;
  }
}
